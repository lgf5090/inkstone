import type { MessageKey } from '../../lib/i18n'

export type LinkKind = 'wiki' | 'markdown' | 'url'

export interface LinkMatch {
  kind: LinkKind
  /** The `!` prefix: the span is written as an embed. */
  embed: boolean
  /** The target names a file the app shows rather than opens as a note. */
  image: boolean
  /** The exact source text of the span, so a rewrite can be recognised as a no-op. */
  raw: string
  start: number
  end: number
  /** The alias, link label, or the text the reader sees for a bare URL. */
  text: string
  /** Where the link points: a note reference, or an address for an external link. */
  target: string
  /** False when the source carries no alias, so the displayed text is derived from the target. */
  hasText: boolean
}

export interface LinkDetectionOptions {
  wiki: boolean
  markdown: boolean
  url: boolean
  image: boolean
}

export interface LinkDraft {
  text: string
  target: string
}

export const ALL_LINK_KINDS: LinkDetectionOptions = { wiki: true, markdown: true, url: true, image: true }

const WIKI_RE = /(!?)\[\[([^[\]\n]{1,200})\]\]/g
const MARKDOWN_RE = /(!?)\[([^\]\n]*)\]\((?:<([^<>\n]*)>|([^\s()\n]+))(?:[ \t]+"[^"\n]*")?\)/g
const URL_RE = /(?:https?:\/\/|ftp:\/\/|mailto:|tel:)[^\s<>"'`|\\^]+/gi
const IMAGE_EXT_RE = /\.(?:png|jpe?g|gif|webp|bmp|svg|avif|ico|mp3|wav|ogg|m4a|pdf|zip)$/i
const TRAILING_PUNCT = /[.,;:!?)\]}>"'`\uFF0C\u3002\uFF1B\uFF01\uFF1F\u3001\uFF09\u3011\u300B\u300D\u300F\u201D\u2019]+$/
const EXTERNAL_RE = /^[a-z][a-z\d+\-.]+:/i
const WINDOWS_DRIVE_RE = /^[a-z]:[/\\]/i

export function findLinkAt(lineText: string, offset: number, options: LinkDetectionOptions = ALL_LINK_KINDS, inclusiveEnd = false): LinkMatch | null {
  const matches = collectLinks(lineText, options)
  return matches.find((match) => offset >= match.start && (inclusiveEnd ? offset <= match.end : offset < match.end)) ?? null
}

export function collectLinks(lineText: string, options: LinkDetectionOptions = ALL_LINK_KINDS): LinkMatch[] {
  const found: LinkMatch[] = []
  const code = inlineCodeRanges(lineText)

  if (options.wiki) {
    for (const match of lineText.matchAll(WIKI_RE)) {
      const start = match.index ?? 0
      const inner = match[2] ?? ''
      const pipe = inner.indexOf('|')
      const target = (pipe >= 0 ? inner.slice(0, pipe) : inner).trim()
      const alias = pipe >= 0 ? inner.slice(pipe + 1).trim() : ''
      const image = options.image && isImageTarget(target)
      if (!image && isImageTarget(target)) continue
      found.push({
        kind: 'wiki',
        embed: match[1] === '!',
        image,
        raw: match[0],
        start,
        end: start + match[0].length,
        text: pipe >= 0 ? alias : image ? '' : defaultWikiText(target),
        target,
        hasText: pipe >= 0,
      })
    }
  }

  if (options.markdown) {
    for (const match of lineText.matchAll(MARKDOWN_RE)) {
      const start = match.index ?? 0
      const target = (match[3] ?? match[4] ?? '').trim()
      const image = options.image && isImageTarget(target)
      if (!image && isImageTarget(target)) continue
      found.push({
        kind: 'markdown',
        embed: match[1] === '!',
        image,
        raw: match[0],
        start,
        end: start + match[0].length,
        text: match[2] ?? '',
        target,
        hasText: true,
      })
    }
  }

  if (options.url) {
    for (const match of lineText.matchAll(URL_RE)) {
      const raw = match[0].replace(TRAILING_PUNCT, '')
      if (!raw) continue
      const start = match.index ?? 0
      const end = start + raw.length
      if (found.some((existing) => start < existing.end && existing.start < end)) continue
      if (code.some(([from, to]) => start >= from && end <= to)) continue
      found.push({ kind: 'url', embed: false, image: false, raw, start, end, text: raw, target: raw, hasText: false })
    }
  }

  return found.sort((left, right) => left.start - right.start)
}

function inlineCodeRanges(lineText: string): [number, number][] {
  const ranges: [number, number][] = []
  let open: { index: number, length: number } | null = null
  for (const run of lineText.matchAll(/`+/g)) {
    const index = run.index ?? 0
    const length = run[0].length
    if (!open) {
      open = { index, length }
    }
    else if (length === open.length) {
      ranges.push([open.index, index + length])
      open = null
    }
  }
  return ranges
}

export function isImageTarget(target: string): boolean {
  return IMAGE_EXT_RE.test((target.split(/[?#]/, 1)[0] ?? target).trim())
}

export function isExternalTarget(target: string): boolean {
  const value = target.trim()
  return EXTERNAL_RE.test(value) && !WINDOWS_DRIVE_RE.test(value)
}

export interface TargetParts {
  note: string
  heading: string | null
  block: string | null
}

export function splitTarget(target: string): TargetParts {
  const value = target.trim()
  if (value.startsWith('^')) return { note: '', heading: null, block: value.slice(1) }
  const hash = value.indexOf('#')
  if (hash < 0) return { note: value, heading: null, block: null }
  const note = value.slice(0, hash).trim()
  const fragment = value.slice(hash + 1).trim()
  return fragment.startsWith('^')
    ? { note, heading: null, block: fragment.slice(1) }
    : { note, heading: fragment || null, block: null }
}

/** The name a wiki link shows when it carries no alias: its file, without folder or extension. */
export function defaultWikiText(target: string): string {
  const { note } = splitTarget(target)
  const withoutExtension = note.replace(/\.md$/i, '')
  const segments = withoutExtension.split('/').filter((part) => part.length > 0)
  return segments[segments.length - 1] ?? ''
}

/** What the reader sees for this span right now, whichever shape it is written in. */
export function displayTextOf(match: LinkMatch): string {
  if (match.kind === 'url') return match.target
  if (match.image) return match.text
  if (match.kind === 'wiki') return match.hasText && match.text ? match.text : defaultWikiText(match.target)
  return match.text || match.target
}

/** What stays in the note when the link is removed and its words are kept. */
export function unwrapTextOf(match: LinkMatch): string {
  if (match.image) return ''
  if (match.kind === 'url') return match.target
  if (match.kind === 'wiki') return match.hasText && match.text ? match.text : defaultWikiText(match.target)
  return match.text || match.target
}

export function canToggleEmbed(match: LinkMatch): boolean {
  return match.kind !== 'url'
}

export function linkKindLabel(match: LinkMatch): MessageKey {
  if (match.kind === 'wiki') return match.image ? 'links.kind_image_wiki' : 'links.kind_wiki'
  if (match.kind === 'markdown') return match.image ? 'links.kind_image_markdown' : 'links.kind_markdown'
  return 'links.kind_url'
}

/**
 * The note text this draft should become.
 *
 * One rule decides the shape for every kind: a target that names something inside the notebook is
 * written as a wiki link, because that is the only shape the renderer turns into a note, and an
 * address is written as markdown. An author who typed `[text](Some Note)` therefore gets
 * `[[Some Note|text]]` back, which is the change they were asking for by retargeting it.
 */
export function serializeLink(match: LinkMatch, draft: LinkDraft): string {
  const text = draft.text.trim()
  const target = draft.target.trim()
  if (!target) return ''
  const embed = match.embed || match.image
  if (!isExternalTarget(target) && isWikiSafeTarget(target)) return wikiLink(target, text, embed)
  if (embed) return `![${escapeLabel(text)}](${formatDestination(target)})`
  if (!text || text === target) return target
  return `[${escapeLabel(text)}](${formatDestination(target)})`
}

/** A wiki target cannot carry brackets or the alias separator, so those shapes fall back to markdown. */
export function isWikiSafeTarget(target: string): boolean {
  return /^[^[\]|\n]+$/.test(target)
}

/** The wiki shape for a target and the words to show for it; the alias is only written when it differs. */
export function wikiLink(target: string, text: string, embed = false): string {
  if (!target) return ''
  const alias = text && text !== defaultWikiText(target) ? `|${text}` : ''
  return `${embed ? '!' : ''}[[${target}${alias}]]`
}

function escapeLabel(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/[[\]]/g, '\\$&')
}

/**
 * A destination may only hold a bracket or an angle bracket inside `<...>`, which is also the shape
 * that lets a URL keep its own parentheses.
 */
function formatDestination(target: string): string {
  return /[\s<>()]/.test(target) ? `<${target}>` : target
}

/** The clipboard shape another Markdown reader wants: a label and an address. */
export function copyAsMarkdown(match: LinkMatch, draft: LinkDraft): string {
  const text = draft.text.trim() || displayTextOf(match)
  const target = draft.target.trim()
  if (!target) return text
  return `${match.embed || match.image ? '!' : ''}[${escapeLabel(text)}](${formatDestination(target)})`
}

/** The clipboard shape this notebook resolves: a wiki link, whose label is only written when it differs. */
export function copyAsWiki(match: LinkMatch, draft: LinkDraft): string {
  const text = draft.text.trim() || displayTextOf(match)
  return wikiLink(draft.target.trim(), text, match.embed || match.image)
}

const BOUNDARY = /[\s.,;:!?)\]}>"'`/\uFF0C\u3002\uFF1B\uFF01\uFF1F\u3001\uFF09\u3011\u300B\u300D\u300F\u201D\u2019]/

/**
 * The reference pads a freshly inserted link so it does not glue itself to the neighbouring word.
 * Only the characters actually beside the insertion point are consulted, so a link typed at the end
 * of a sentence gains nothing.
 */
export function padNewLink(linkText: string, lineText: string, at: number): { text: string, cursor: number } {
  const before = at > 0 ? lineText.charAt(at - 1) : ''
  const after = at < lineText.length ? lineText.charAt(at) : ''
  const left = before && !BOUNDARY.test(before) ? ' ' : ''
  const right = after && !BOUNDARY.test(after) ? ' ' : ''
  const text = `${left}${linkText}${right}`
  return { text, cursor: text.length - (right ? 1 : 0) }
}

const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/
const HEADING_RE = /^ {0,3}(#{1,6})[ \t]+(.*?)[ \t]*#*[ \t]*$/

/**
 * The headings a note offers as link targets, read the way the block rules read them: a fence swallows
 * every `#` inside it, and the front matter block is property text rather than prose.
 */
export function headingsIn(text: string): { level: number, text: string }[] {
  const out: { level: number, text: string }[] = []
  const lines = text.split(/\r?\n/)
  let fence: string | null = null
  let frontMatter = /^---[ \t]*$/.test(lines[0] ?? '')
  for (const line of lines) {
    if (frontMatter) {
      if (/^(---|\.\.\.|===)[ \t]*$/.test(line)) frontMatter = false
      continue
    }
    const run = FENCE_RE.exec(line)
    if (run) {
      const marker = run[1]!
      if (!fence) fence = marker[0]!
      else if (fence === marker[0]!) fence = null
      continue
    }
    if (fence) continue
    const heading = HEADING_RE.exec(line)
    if (heading?.[2]) out.push({ level: heading[1]!.length, text: heading[2].trim() })
  }
  return out
}
