/** Provides pure Markdown analysis shared by the browser and Worker runtimes. */
import { isSeq, parseDocument, Scalar } from 'yaml'
import { truncateText } from './text-utils'


export function stripCodeRegions(text: string): string {
  const lines = text.split('\n')
  let inFence = false
  let fenceChar = ''
  let fenceLen = 0

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const m = /^[ \t]{0,3}(`{3,}|~{3,})(.*)$/.exec(line)
    if (m) {
      const marker = m[1]!
      const ch = marker[0]!
      if (!inFence && !(ch === '`' && m[2]!.includes('`'))) {
        inFence = true
        fenceChar = ch
        fenceLen = marker.length
        lines[i] = ''
        continue
      }
      if (ch === fenceChar && marker.length >= fenceLen && !m[2]!.trim()) {
        inFence = false
        lines[i] = ''
        continue
      }
    }
    if (inFence) {
      lines[i] = ''
      continue
    }
    lines[i] = line.replace(/`+[^`\n]*`+/g, (s) => ' '.repeat(s.length))
  }
  return stripObsidianCommentRegions(lines.join('\n'))
}

function stripObsidianCommentRegions(text: string): string {
  const chars = text.split('')
  let start = -1
  for (let index = 0; index < text.length - 1; index++) {
    if (!text.startsWith('%%', index) || isEscaped(text, index)) continue
    if (start < 0) start = index
    else {
      for (let cursor = start; cursor <= index + 1; cursor++) {
        if (chars[cursor] !== '\n' && chars[cursor] !== '\r') chars[cursor] = ' '
      }
      start = -1
    }
    index++
  }
  if (start >= 0) {
    for (let cursor = start; cursor < chars.length; cursor++) {
      if (chars[cursor] !== '\n' && chars[cursor] !== '\r') chars[cursor] = ' '
    }
  }
  return chars.join('')
}

export interface FrontMatterResult {
  body: string
  data: Record<string, unknown>
  raw: string

  lineOffset: number
  errors: string[]
}

const FRONT_MATTER_LIMIT = 64 * 1024
const UTF8_ENCODER = new TextEncoder()


export function parseFrontMatter(text: string): FrontMatterResult {
  const source = text.startsWith('\uFEFF') ? text.slice(1) : text
  if (!/^---[ \t]*(?:\r?\n|$)/.test(source)) {
    return { body: source, data: {}, raw: '', lineOffset: 0, errors: [] }
  }

  const lines = source.split(/\r?\n/)
  const separators = source.match(/\r?\n/g) ?? []
  let closing = -1
  let bytes = UTF8_ENCODER.encode(lines[0]!).byteLength
  for (let index = 1; index < lines.length; index++) {
    bytes += UTF8_ENCODER.encode(separators[index - 1] ?? '').byteLength
    bytes += UTF8_ENCODER.encode(lines[index]!).byteLength
    if (bytes > FRONT_MATTER_LIMIT) {
      return {
        body: source,
        data: {},
        raw: '',
        lineOffset: 0,
        errors: ['Front Matter exceeds the 64 KiB safety limit'],
      }
    }
    if (/^(?:---|\.\.\.)[ \t]*$/.test(lines[index]!)) {
      closing = index
      break
    }
  }
  if (closing < 0) return { body: source, data: {}, raw: '', lineOffset: 0, errors: [] }

  const raw = lines.slice(1, closing).join('\n')
  try {
    const document = parseDocument(raw, {
      prettyErrors: false,
      uniqueKeys: true,
    })
    const errors = document.errors.map((error) => error.message)
    if (errors.length) {
      return {
        body: lines.slice(closing + 1).join('\n'),
        data: {},
        raw,
        lineOffset: closing + 1,
        errors,
      }
    }
    const value = document.toJS({ maxAliasCount: 20 }) as unknown
    const data = isPlainRecord(value) ? value : {}
    if (value != null && !isPlainRecord(value)) {
      errors.push('Front Matter root must be a YAML mapping')
    }
    return {
      body: lines.slice(closing + 1).join('\n'),
      data,
      raw,
      lineOffset: closing + 1,
      errors,
    }
  } catch (error) {
    return {
      body: lines.slice(closing + 1).join('\n'),
      data: {},
      raw,
      lineOffset: closing + 1,
      errors: [error instanceof Error ? error.message : String(error)],
    }
  }
}


export function splitFrontMatter(text: string): { body: string; meta: Record<string, string> } {
  const parsed = parseFrontMatter(text)
  const meta: Record<string, string> = {}
  for (const [key, value] of Object.entries(parsed.data)) {
    if (value == null) continue
    if (typeof value === 'string') meta[key] = value
    else if (typeof value === 'number' || typeof value === 'boolean') meta[key] = String(value)
    else meta[key] = JSON.stringify(value)
  }
  return { body: parsed.body, meta }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/** Obsidian's `|600` / `|600x400` suffix: a size, never a label. */
const EMBED_SIZE_RE = /^\d{1,5}(?:[xX]\d{1,5})?$/

export function parseEmbedSizeSpec(value: string | null | undefined): { width: number | null; height: number | null } | null {
  const spec = value?.trim()
  if (!spec || !EMBED_SIZE_RE.test(spec)) return null
  const [width, height] = spec.toLowerCase().split('x')
  return { width: Number(width) || null, height: Number(height) || null }
}

/** What a `[[target|alias]]` reads as in plain text: the alias, unless the alias is only a size. */
export function wikiLinkText(target: string, alias?: string | null): string {
  const value = alias && alias.trim() && !EMBED_SIZE_RE.test(alias.trim()) ? alias : target
  return (value.split(/[\\/]/).pop() ?? value).trim()
}

const TAG_RE = /(^|[\s(\uff08[\u3010>\u300c\u300e\uff0c,\u3001;\uff1b])#([\p{L}\p{N}_\-/·]{1,60})(?![\p{L}\p{N}_\-/·])/gu
const TAG_COLLATOR = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' })

interface BodyTagOccurrence {
  name: string
  hashStart: number
  nameStart: number
  nameEnd: number
}

function isEscaped(text: string, index: number): boolean {
  let slashes = 0
  for (let i = index - 1; i >= 0 && text[i] === '\\'; i--) slashes++
  return slashes % 2 === 1
}

/**
 * Tab labels render as plain text inside their buttons, so a `[[wikilink]]` or `#tag` written
 * on an item line is not a link anywhere else either. Blanked in place: the offsets that
 * `replaceTagInContent` splices with have to stay valid.
 */
function blankTabLabels(text: string): string {
  return text
    .replace(/^([ \t]{0,3}:{3,}(?:\{tab-item\}|[ \t]*tab-item)(?![\w-]))[^\r\n]*$/gm, (whole, head: string) => head + ' '.repeat(whole.length - head.length))
    .replace(/^([ \t]*@tab)(?![\w-])[^\r\n]*$/gim, (whole, head: string) => head + ' '.repeat(whole.length - head.length))
}

function tagSearchText(input: string): string {
  const text = blankTabLabels(input)
  const protectedChars = new Uint8Array(text.length)
  const protect = (start: number, end: number) => {
    const boundedStart = Math.max(0, start)
    const boundedEnd = Math.min(text.length, end)
    for (let i = boundedStart; i < boundedEnd; i++) protectedChars[i] = 1
  }

  let inFence = false
  let fenceChar = ''
  let fenceLen = 0
  let lineStart = 0
  while (lineStart < text.length) {
    const newline = text.indexOf('\n', lineStart)
    const lineEnd = newline < 0 ? text.length : newline + 1
    const line = text.slice(lineStart, newline < 0 ? text.length : newline).replace(/\r$/, '')
    const fence = /^[ \t]{0,3}(`{3,}|~{3,})/.exec(line)
    if (fence) {
      const marker = fence[1]!
      if (!inFence) {
        inFence = true
        fenceChar = marker[0]!
        fenceLen = marker.length
      } else if (marker[0] === fenceChar && marker.length >= fenceLen) {
        inFence = false
      }
      protect(lineStart, lineEnd)
    } else if (inFence) {
      protect(lineStart, lineEnd)
    }
    lineStart = lineEnd
  }

  for (let i = 0; i < text.length;) {
    if (protectedChars[i] || text[i] !== '`' || isEscaped(text, i)) {
      i++
      continue
    }
    let markerEnd = i + 1
    while (text[markerEnd] === '`') markerEnd++
    const markerLength = markerEnd - i
    let closing = markerEnd
    let matched = false
    while (closing < text.length) {
      closing = text.indexOf('`', closing)
      if (closing < 0) break
      let closingEnd = closing + 1
      while (text[closingEnd] === '`') closingEnd++
      if (closingEnd - closing === markerLength) {
        protect(i, closingEnd)
        i = closingEnd
        matched = true
        break
      }
      closing = closingEnd
    }
    if (!matched) i = markerEnd
  }

  const protectPattern = (pattern: RegExp) => {
    for (const match of text.matchAll(pattern)) {
      const start = match.index
      if (start === undefined) continue
      let overlaps = false
      for (let i = start; i < start + match[0].length; i++) {
        if (protectedChars[i]) {
          overlaps = true
          break
        }
      }
      if (!overlaps) protect(start, start + match[0].length)
    }
  }

  protectPattern(/<!--(?:[\s\S]*?-->|[\s\S]*$)/g)
  protectPattern(/\$\$(?:[\s\S]*?\$\$|[\s\S]*$)/g)
  protectPattern(/\$(?!\s)(?:[^$\\]|\\.)+?(?<!\s)\$/g)

  let commentStart = -1
  for (let index = 0; index < text.length - 1; index++) {
    if (protectedChars[index] || !text.startsWith('%%', index) || isEscaped(text, index)) continue
    if (commentStart < 0) commentStart = index
    else {
      protect(commentStart, index + 2)
      commentStart = -1
    }
    index++
  }
  if (commentStart >= 0) protect(commentStart, text.length)

  lineStart = 0
  while (lineStart < text.length) {
    const newline = text.indexOf('\n', lineStart)
    const lineEnd = newline < 0 ? text.length : newline + 1
    const line = text.slice(lineStart, newline < 0 ? text.length : newline)
    if (/^[ \t]{0,3}\[(?!\^)[^\]\n]+\]:/.test(line)) protect(lineStart, lineEnd)
    lineStart = lineEnd
  }

  const bracketStack: Array<{ start: number; image: boolean }> = []
  for (let i = 0; i < text.length; i++) {
    if (protectedChars[i] || isEscaped(text, i)) continue

    if (text.startsWith('[[', i)) {
      const closing = text.indexOf(']]', i + 2)
      if (closing >= 0) {
        const pipe = text.indexOf('|', i + 2)
        const targetEnd = pipe >= 0 && pipe < closing ? pipe : closing
        protect(i, pipe >= 0 && pipe < closing ? targetEnd + 1 : targetEnd)
        protect(closing, closing + 2)
        i = targetEnd - 1
        continue
      }
    }

    if (text[i] === '<' && /[A-Za-z/!?]/.test(text[i + 1] ?? '')) {
      let end = i + 1
      let quote = ''
      while (end < text.length) {
        const ch = text[end]!
        if (quote) {
          if (ch === quote && !isEscaped(text, end)) quote = ''
        } else if (ch === '"' || ch === "'") {
          quote = ch
        } else if (ch === '>') {
          end++
          break
        }
        end++
      }
      if (end <= text.length && end > i + 1 && text[end - 1] === '>') {
        protect(i, end)
        i = end - 1
        continue
      }
    }

    if (text[i] === '[') {
      bracketStack.push({ start: i, image: i > 0 && text[i - 1] === '!' && !isEscaped(text, i - 1) })
      continue
    }
    if (text[i] !== ']' || bracketStack.length === 0) continue

    const opening = bracketStack.pop()!
    const destinationStart = i + 1
    if (text[destinationStart] === '(') {
      let depth = 1
      let quote = ''
      let end = destinationStart + 1
      for (; end < text.length; end++) {
        if (protectedChars[end] || isEscaped(text, end)) continue
        const ch = text[end]!
        if (quote) {
          if (ch === quote) quote = ''
          continue
        }
        if (ch === '"' || ch === "'") {
          quote = ch
          continue
        }
        if (ch === '(') depth++
        else if (ch === ')' && --depth === 0) {
          end++
          break
        }
      }
      if (depth === 0) {
        protect(destinationStart, end)
        if (opening.image) protect(opening.start - 1, end)
        i = end - 1
      } else if (opening.image) {
        protect(opening.start - 1, i + 1)
      }
    } else if (opening.image) {
      protect(opening.start - 1, i + 1)
    }
  }

  protectPattern(/(?:https?|ftp):\/\/[^\s<>]+|mailto:[^\s<>]+|\bwww\.[^\s<>]+/giu)

  const chars = text.split('')
  for (let i = 0; i < chars.length; i++) {
    if (protectedChars[i] && chars[i] !== '\n' && chars[i] !== '\r') chars[i] = ' '
  }
  return chars.join('')
}

function bodyTagOccurrences(content: string): BodyTagOccurrence[] {
  const safe = tagSearchText(content)
  const occurrences: BodyTagOccurrence[] = []
  for (const match of safe.matchAll(TAG_RE)) {
    const raw = match[2]!
    const name = raw.replace(/[.,\uff0c\u3002;\uff1b:\uff1a!\uff01?\uff1f\u3001·/]+$/u, '')
    if (!name || /^\d+$/.test(name) || name.length > 60) continue
    const hashStart = match.index! + match[1]!.length
    const nameStart = hashStart + 1
    occurrences.push({ name, hashStart, nameStart, nameEnd: nameStart + name.length })
  }
  return occurrences
}


export function compareTagNames(a: string, b: string): number {
  return TAG_COLLATOR.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0)
}

export function sortTagNames(tags: Iterable<string>): string[] {
  return [...tags].sort(compareTagNames)
}


/**
 * The deduplication key `extractTags` uses: case- and width-insensitive. Listings call this once
 * per tag per keystroke, so the same handful of names are folded over and over; the bounded cache
 * follows the one in lib/fuzzy.ts.
 */
const TAG_KEY_CACHE_LIMIT = 20_000
const tagKeyCache = new Map<string, string>()

export function tagKey(name: string): string {
  const hit = tagKeyCache.get(name)
  if (hit !== undefined) return hit
  const key = name.normalize('NFKC').toLocaleLowerCase()
  if (tagKeyCache.size < TAG_KEY_CACHE_LIMIT) tagKeyCache.set(name, key)
  return key
}

function keyInScope(tag: string, want: string): boolean {
  return tag === want
    || (tag.length > want.length && tag[want.length] === '/' && tag.startsWith(want))
}

/**
 * A tag covers its whole subtree, so filtering or counting `work` also means `work/meeting`.
 * The notes list route spells the same rule in SQL, but `COLLATE NOCASE` only folds ASCII, so a
 * non-ASCII case variant can match here and not there. The offline shell is the stricter side.
 */
export function tagInScope(tagName: string, scope: string): boolean {
  return keyInScope(tagKey(tagName), tagKey(scope))
}

/**
 * Whether two spellings name the same tag. `localeCompare(…, { sensitivity: 'base' })` looks
 * like the same question but also folds German expansions (`ß`/`ss`) and accent equivalences
 * the server's `COLLATE NOCASE` never folds, so it predicts a merge that will not happen.
 */
export function tagNamesEqual(left: string, right: string): boolean {
  return tagKey(left) === tagKey(right)
}

export function notesCarryEveryTag(tagLists: readonly string[], scopes: readonly string[]): boolean {
  const wants = cachedKeys(scopes)
  const tags = cachedKeys(tagLists)
  return wants.every((want) => tags.some((tag) => keyInScope(tag, want)))
}

export function notesCarryAnyTag(tagLists: readonly string[], scopes: readonly string[]): boolean {
  const wants = cachedKeys(scopes)
  const tags = cachedKeys(tagLists)
  return wants.some((want) => tags.some((tag) => keyInScope(tag, want)))
}

function cachedKeys(names: readonly string[]): string[] {
  const out: string[] = []
  for (const name of names) {
    const key = tagKey(name)
    if (!out.includes(key)) out.push(key)
  }
  return out
}

export function extractTags(content: string): string[] {
  const frontMatter = parseFrontMatter(content)
  const out = new Map<string, string>()
  const add = (value: string) => {
    const key = tagKey(value)
    if (!out.has(key)) out.set(key, value)
  }
  for (const tag of frontMatterTags(frontMatter.data)) {
    const normalized = tag.replace(/^#/, '').trim()
    if (isUsableTagName(normalized) && normalized.length <= 60 && !/^\d+$/.test(normalized)) add(normalized)
    if (out.size >= 64) return sortTagNames(out.values())
  }
  for (const occurrence of bodyTagOccurrences(frontMatter.body)) {
    add(occurrence.name)
    if (out.size >= 64) break
  }
  return sortTagNames(out.values())
}

/**
 * A tag list can be separated by ASCII or by the full-width punctuation a Chinese keyboard
 * produces. YAML only splits a flow sequence on the ASCII comma, so `tags: [a\uFF0Cb]` reaches us as
 * the single item `a\uFF0Cb`; splitting here is what stops that becoming one bogus tag.
 */
export const TAG_LIST_SEPARATOR = /[,\uFF0C\u3001;\uFF1B\s]+/

export function isUsableTagName(name: string): boolean {
  return name.length > 0 && !/[\s#]/.test(name) && !/[,\uFF0C\u3001;\uFF1B]/.test(name)
}

function frontMatterTags(data: Record<string, unknown>): string[] {
  const value = data.tags ?? data.tag
  const raw = Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : typeof value === 'string'
      ? [value.replace(/^\[|\]$/g, '')]
      : []
  return raw.flatMap((item) => item.split(TAG_LIST_SEPARATOR)).map((item) => item.trim()).filter(Boolean)
}

const WIKI_RE = /\[\[([^[\]|\n]{1,400})(?:\|([^[\]\n]{0,200}))?\]\]/g

export interface WikiLink {
  target: string
  alias: string | null
  key: string
}


export function extractWikiLinks(content: string): WikiLink[] {
  const safe = blankTabLabels(stripCodeRegions(splitFrontMatter(content).body))
  const seen = new Set<string>()
  const out: WikiLink[] = []
  for (const m of safe.matchAll(WIKI_RE)) {
    const target = m[1]!.trim()
    if (!target) continue
    const noteTarget = wikiNoteTarget(target)
    if (!noteTarget) continue
    const key = normalizeLinkKey(noteTarget)
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ target, alias: m[2]?.trim() || null, key })
    if (out.length >= 200) break
  }
  return out
}

const ATTACHMENT_REFERENCE_RE =
  /(?:^|[\s(<"'=])(?:https?:\/\/[^/\s<>"']+)?\/api\/files\/([0-9a-hjkmnp-tv-z]{26})(?=$|[\s>)\]"'?#])/g


export interface AttachmentScanLimits {
  maxDepth?: number
  maxChars?: number
}

export interface AttachmentScan {
  ids: string[]
  truncated: boolean
}

// Each nesting level re-scans its own subtree, so uncapped md-example nesting makes
// the work quadratic in depth: one note can cost seconds of CPU per read, per save
// and per backup. Callers that only gate a read pass tighter limits than the ones
// whose counts decide deletion or backup completeness.
const ATTACHMENT_SCAN_MAX_DEPTH = 8
const ATTACHMENT_SCAN_MAX_CHARS = 12_000_000

export function scanAttachmentReferences(
  content: string,
  limits: AttachmentScanLimits = {},
): AttachmentScan {
  const maxDepth = limits.maxDepth ?? ATTACHMENT_SCAN_MAX_DEPTH
  const maxChars = limits.maxChars ?? ATTACHMENT_SCAN_MAX_CHARS
  const ids = new Set<string>()
  let frontier: string[] = [content]
  let scanned = 0
  let truncated = false
  // md-example fences are rendered as live markdown by the client renderer,
  // so references inside them count even though stripCodeRegions discards
  // them as ordinary code regions.
  for (let depth = 0; frontier.length > 0 && !truncated; depth++) {
    if (depth >= maxDepth) {
      truncated = true
      break
    }
    const next: string[] = []
    for (const entry of frontier) {
      const body = splitFrontMatter(entry).body
      for (const match of stripCodeRegions(body).matchAll(ATTACHMENT_REFERENCE_RE)) ids.add(match[1]!)
      scanned += body.length
      if (scanned > maxChars) {
        truncated = true
        break
      }
      next.push(...markdownExampleBodies(body))
    }
    frontier = next
  }
  if (truncated) {
    // A partial result would under-report references, and both attachment pruning and
    // backups delete or omit files on the strength of those counts. One flat pass over
    // the body is linear and over-counts code samples instead of missing a reference.
    const flat = new Set<string>()
    for (const match of splitFrontMatter(content).body.matchAll(ATTACHMENT_REFERENCE_RE)) {
      flat.add(match[1]!)
    }
    return { ids: [...flat], truncated: true }
  }
  return { ids: [...ids], truncated: false }
}

export function extractAttachmentIds(content: string, limits?: AttachmentScanLimits): string[] {
  return scanAttachmentReferences(content, limits).ids
}

function markdownExampleBodies(text: string): string[] {
  const bodies: string[] = []
  const lines = text.split('\n')
  let fenceChar = ''
  let fenceLen = 0
  let collecting: string[] | null = null
  for (const line of lines) {
    const fence = /^[ \t]{0,3}(`{3,}|~{3,})(.*)$/.exec(line)
    if (fence) {
      const marker = fence[1]!
      if (!fenceChar && !(marker[0] === '`' && fence[2]!.includes('`'))) {
        fenceChar = marker[0]!
        fenceLen = marker.length
        if (/^\s*(?:md-example|markdown-example)\b/.test(fence[2] ?? '')) collecting = []
        continue
      } else if (marker[0]! === fenceChar && marker.length >= fenceLen && !(fence[2] ?? '').trim()) {
        // A closing fence may only be followed by spaces or tabs.
        if (collecting !== null) bodies.push(collecting.join('\n'))
        collecting = null
        fenceChar = ''
        fenceLen = 0
        continue
      }
    }
    if (collecting !== null) collecting.push(line)
  }
  if (collecting) bodies.push(collecting.join('\n'))
  return bodies
}

export function normalizeLinkKey(title: string): string {
  return title.trim().toLowerCase().replace(/\s+/g, ' ')
}


export function wikiNoteTarget(target: string): string {
  const value = target.trim()
  if (!value || value.startsWith('#') || value.startsWith('^')) return ''
  const hash = value.indexOf('#')
  return (hash >= 0 ? value.slice(0, hash) : value).trim()
}

export function replaceTagInContent(content: string, from: string, to: string | null): string {
  const frontMatter = parseFrontMatter(content)
  const hasFrontMatter = frontMatter.lineOffset > 0
  const normalized = content.replace(/\r\n/g, '\n')
  const lines = normalized.split('\n')
  const header = hasFrontMatter ? lines.slice(0, frontMatter.lineOffset) : []
  const body = hasFrontMatter ? lines.slice(frontMatter.lineOffset).join('\n') : normalized
  const rewrittenFrontMatter = hasFrontMatter && frontMatter.errors.length === 0
    ? replaceTagInFrontMatter(header, frontMatter.raw, from, to)
    : header
  const rewrittenBody = replaceInlineTag(body, from, to)
  return [...rewrittenFrontMatter, rewrittenBody].join('\n')
}

function replaceInlineTag(content: string, from: string, to: string | null): string {
  const matches = bodyTagOccurrences(content).filter((occurrence) => occurrence.name === from)
  let rewritten = content
  for (let i = matches.length - 1; i >= 0; i--) {
    const match = matches[i]!
    if (to) {
      rewritten = rewritten.slice(0, match.nameStart) + to + rewritten.slice(match.nameEnd)
    } else {
      rewritten = rewritten.slice(0, match.hashStart) + rewritten.slice(match.nameEnd)
    }
  }
  return rewritten
}

function replaceTagInFrontMatter(
  header: string[],
  raw: string,
  from: string,
  to: string | null,
): string[] {
  const document = parseDocument(raw, { prettyErrors: false, uniqueKeys: true })
  if (document.errors.length) return header
  const data = document.toJS({ maxAliasCount: 20 }) as unknown
  if (!isPlainRecord(data)) return header
  const key = Object.prototype.hasOwnProperty.call(data, 'tags')
    ? 'tags'
    : Object.prototype.hasOwnProperty.call(data, 'tag') ? 'tag' : null
  if (!key) return header
  const value = data[key]
  const rewrite = (tag: string) => {
    const hash = tag.trim().startsWith('#') ? '#' : ''
    const name = tag.trim().replace(/^#/, '')
    if (name !== from) return tag
    return to ? `${hash}${to}` : null
  }
  let next: string[] | string | null = null
  if (Array.isArray(value)) {
    const values = value
      .filter((item): item is string => typeof item === 'string')
      .map(rewrite)
      .filter((item): item is string => item !== null)
    if (values.length === value.length && values.every((item, index) => item === value[index])) return header
    next = values.length ? values : null
  } else if (typeof value === 'string') {
    const separator = value.includes(',') ? ', ' : ' '
    const values = frontMatterTags({ [key]: value })
      .map(rewrite)
      .filter((item): item is string => item !== null)
    const joined = values.join(separator)
    if (joined === value) return header
    next = joined || null
  } else {
    return header
  }
  if (next === null) document.delete(key)
  else if (Array.isArray(next)) {
    // Replace the sequence's items in place: `document.set` builds a fresh node that always
    // stringifies as a block list, which would turn the user's `tags: [a, b]` into three lines.
    // Assigning `flow` on the new node is ignored by yaml, and so is createNode({ type: 'flow' }).
    const node = document.get(key, true)
    if (isSeq(node)) node.items = next.map((item) => new Scalar(item))
    else document.set(key, next)
  }
  else document.set(key, next)
  const closing = header.at(-1) ?? '---'
  const serialized = stringifyFrontMatter(document)
  return [header[0] ?? '---', ...(serialized ? serialized.split('\n') : []), closing]
}

/**
 * `yaml` pads flow collections by default, so a round-trip would rewrite the user's own
 * `tags: [a, b]` into `tags: [ a, b ]` on every property edit.
 */
function stringifyFrontMatter(document: FrontMatterDocument): string {
  return document.toString({ flowCollectionPadding: false }).replace(/\n$/, '')
}

export type FrontMatterValue = string | number | boolean | string[]

type FrontMatterDocument = ReturnType<typeof parseDocument>

export function setFrontMatterValue(
  content: string,
  key: string,
  value: FrontMatterValue,
): string {
  return rewriteFrontMatter(content, (document) => {
    document.set(key, value)
    return true
  })
}

export function deleteFrontMatterValue(content: string, key: string): string {
  return rewriteFrontMatter(content, (document) => {
    if (!document.has(key)) return false
    document.delete(key)
    return true
  })
}

export function renameFrontMatterValue(content: string, from: string, to: string): string {
  if (!from || from === to) return content
  return rewriteFrontMatter(content, (document) => {
    if (!document.has(from) || document.has(to)) return false
    document.set(to, document.get(from))
    document.delete(from)
    return true
  })
}

function rewriteFrontMatter(
  content: string,
  mutate: (document: FrontMatterDocument) => boolean,
): string {
  const parsed = parseFrontMatter(content)
  if (parsed.errors.length) return content
  const document = parseDocument(parsed.raw, { prettyErrors: false, uniqueKeys: true })
  if (document.errors.length) return content
  if (!mutate(document)) return content
  const lines = content.split('\n')
  const body = lines.slice(parsed.lineOffset)
  const remaining = document.toJS({ maxAliasCount: 20 }) as unknown
  if (remaining === null || remaining === undefined
    || (isPlainRecord(remaining) && !Object.keys(remaining).length)) {
    return body.join('\n')
  }
  const serialized = stringifyFrontMatter(document)
  if (!serialized.trim()) return body.join('\n')
  const opening = parsed.lineOffset ? lines[0] ?? '---' : '---'
  const closing = parsed.lineOffset ? lines[parsed.lineOffset - 1] ?? '---' : '---'
  return [opening, ...serialized.split('\n'), closing, ...body].join('\n')
}

function replaceWikiLinkTargetLine(content: string, from: string, to: string): string {
  const fromKey = normalizeLinkKey(from)
  return content.replace(
    /\[\[([^[\]|\n]{1,400})(\|[^[\]\n]{0,200})?\]\]/g,
    (whole, target: string, alias?: string) => {
      const note = wikiNoteTarget(target)
      if (normalizeLinkKey(note) !== fromKey) return whole
      const fragment = target.slice(note.length)
      return `[[${to}${fragment}${alias ?? ''}]]`
    },
  )
}

export function replaceWikiLinkTarget(content: string, from: string, to: string): string {
  const frontMatter = parseFrontMatter(content)
  const lines = content.split('\n')
  let inFence = false
  let fenceChar = ''
  let fenceLength = 0
  for (let index = frontMatter.lineOffset; index < lines.length; index++) {
    const line = lines[index]!
    const fence = /^[ \t]{0,3}(`{3,}|~{3,})/.exec(line)
    if (fence) {
      const marker = fence[1]!
      if (!inFence) {
        inFence = true
        fenceChar = marker[0]!
        fenceLength = marker.length
      } else if (marker[0] === fenceChar && marker.length >= fenceLength) {
        inFence = false
      }
      continue
    }
    if (inFence) continue
    const safe = line.replace(/`+[^`\n]*`+/g, (value) => ' '.repeat(value.length))
    if (safe === line) {
      lines[index] = replaceWikiLinkTargetLine(line, from, to)
      continue
    }
    const replacements: Array<{ start: number; end: number; value: string }> = []
    for (const match of safe.matchAll(WIKI_RE)) {
      const original = line.slice(match.index!, match.index! + match[0].length)
      const value = replaceWikiLinkTargetLine(original, from, to)
      if (value !== original) replacements.push({ start: match.index!, end: match.index! + match[0].length, value })
    }
    let next = line
    for (const replacement of replacements.reverse()) {
      next = next.slice(0, replacement.start) + replacement.value + next.slice(replacement.end)
    }
    lines[index] = next
  }
  return lines.join('\n')
}

function stripContainerMarkers(text: string): string {
  return text
    .replace(/^[ \t]{0,3}:{3,}.*$/gm, (line) => {
      const afterColons = line.replace(/^[ \t]{0,3}:{3,}[ \t]*/, '')
      const keyword = /^(?:\{(?:tab-set|tab-item)\}|(?:details|tabs|tab-item)(?![\w-]))[ \t]*/.exec(afterColons)
      const label = keyword ? afterColons.slice(keyword[0].length) : afterColons
      return /^\[[^\]\n]*\]$/.test(label.trim()) ? label.trim().slice(1, -1) : label
    })
    .replace(/^[ \t]*@tab[ \t]+/gm, '')
    .replace(/^[ \t]*\[![A-Za-z][A-Za-z0-9_-]{0,31}\][+-]?[ \t]*/gm, '')
}

export function deriveTitle(content: string, fallback = "Untitled note"): string {
  const { body, meta } = splitFrontMatter(content)
  if (meta.title) return trimTitle(meta.title)
  const safe = stripContainerMarkers(stripCodeRegions(body))
  const lines = safe.split('\n')
  for (const line of lines) {
    const h = /^[ \t]{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line)
    if (h) {
      const t = inlinePlain(h[2]!)
      if (t) return trimTitle(t)
    }
  }
  for (const line of lines) {
    const t = inlinePlain(line.replace(/^[ \t>*+\-]+/, '').replace(/^\d+[.)]\s*/, ''))
    if (t) return trimTitle(t)
  }
  return fallback
}

function trimTitle(t: string): string {
  const clean = t.replace(/\s+/g, ' ').trim()
  return clean.length > 200 ? truncateText(clean, 200) + '…' : clean
}

export function deriveExcerpt(content: string, max = 220): string {
  const plain = toPlainText(content)
  const title = deriveTitle(content, '')
  let text = plain
  if (title && text.startsWith(title)) text = text.slice(title.length)
  text = text.replace(/^[\s\n]+/, '').replace(/\s*\n\s*/g, ' ').trim()
  if (text.length <= max) return text
  return truncateText(text, max).replace(/\s+\S*$/, '') + '…'
}

// Same result as the /( ! )\[([^\]]*)\]\([^)]*\)/g pass, as one left-to-right scan:
// the regex backtracks across the rest of the text for every '[' whose '(' is never
// closed, which costs seconds on a note near the content size limit.
function stripLinkTargets(text: string, requireBang: boolean): string {
  let out = ''
  let copied = 0
  let at = 0
  while (at < text.length) {
    const open = requireBang ? text.indexOf('![', at) : text.indexOf('[', at)
    if (open < 0) break
    const labelStart = open + (requireBang ? 2 : 1)
    const close = text.indexOf(']', labelStart)
    if (close < 0) break
    if (text[close + 1] !== '(') {
      at = open + 1
      continue
    }
    const urlEnd = text.indexOf(')', close + 2)
    if (urlEnd < 0) break
    out += text.slice(copied, open) + text.slice(labelStart, close)
    copied = urlEnd + 1
    at = copied
  }
  return out + text.slice(copied)
}

function inlinePlain(line: string): string {
  return stripLinkTargets(stripLinkTargets(line, true), false)
    .replace(/!?\[\[([^[\]|]+)(?:\|([^[\]]+))?\]\]/g, (_s, a: string, b?: string) => wikiLinkText(a, b))
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(\*|_)(.*?)\1/g, '$2')
    .replace(/~~(.*?)~~/g, '$1')
    .replace(/==(.*?)==/g, '$1')
    .replace(/<[^>]{1,200}>/g, '')
    .replace(/`+/g, '')
    .trim()
}


export function toPlainText(md: string): string {
  let t = stripCodeRegions(splitFrontMatter(md).body)
  t = t.replace(/^ {0,3}(?:[-*_][ \t]*){3,}$/gm, '')
  t = t.replace(/^[ \t]{0,3}#{1,6}\s+/gm, '')
  t = t.replace(/^[ \t]{0,3}>[ \t]?/gm, '')
  t = stripContainerMarkers(t)
  t = t.replace(/^[ \t]*[-*+][ \t]+\[[ xX]\][ \t]+/gm, '')
  t = t.replace(/^[ \t]*[-*+][ \t]+/gm, '')
  t = t.replace(/^[ \t]*\d+[.)][ \t]+/gm, '')
  t = t.replace(/^[ \t]*\|.*\|[ \t]*$/gm, (row) =>
    /^[ \t]*\|[\s:|-]+\|[ \t]*$/.test(row) ? '' : row.replace(/\|/g, ' '),
  )
  t = stripLinkTargets(stripLinkTargets(t, true), false)
  t = t.replace(/!?\[\[([^[\]|]+)(?:\|([^[\]]+))?\]\]/g, (_s, a: string, b?: string) => wikiLinkText(a, b))
  t = t.replace(/\$\$([\s\S]*?)\$\$/g, ' $1 ')
  t = t.replace(/\$([^$\n]+)\$/g, ' $1 ')
  t = t.replace(/(\*\*|__)(.*?)\1/g, '$2')
  t = t.replace(/(\*|_)(.*?)\1/g, '$2')
  t = t.replace(/~~(.*?)~~/g, '$1')
  t = t.replace(/==(.*?)==/g, '$1')
  t = t.replace(/<[^>]{1,300}>/g, '')
  t = t.replace(/^\[\^[^\]]+\]:/gm, '')
  t = t.replace(/\[\^[^\]]+\]/g, '')
  return t.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim()
}

const CJK_GLOBAL = /[\u2e80-\u9fff\uf900-\ufaff\uff01-\uffe0]/g

/** Code point count without materialising `[...text]`, which costs one array slot per character. */
function codePointLength(text: string): number {
  let total = 0
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) {
      const next = text.charCodeAt(index + 1)
      if (next >= 0xdc00 && next <= 0xdfff) index++
    }
    total++
  }
  return total
}

export function countText(md: string): { words: number; chars: number } {
  const plain = toPlainText(md)
  let cjk = 0
  // The CJK ranges are all BMP, so scanning UTF-16 units matches the per-code-point test
  // while surrogate pairs (which decode outside those ranges) stay uncounted either way.
  for (let index = 0; index < plain.length; index++) {
    const code = plain.charCodeAt(index)
    if ((code >= 0x2e80 && code <= 0x9fff) || (code >= 0xf900 && code <= 0xfaff)) cjk++
  }
  const latin = plain.match(/[A-Za-z0-9_'’-]+/g)?.length ?? 0
  return { words: cjk + latin, chars: codePointLength(md) }
}


export function segmentCJK(text: string): string {
  return text.replace(CJK_GLOBAL, ' $& ').replace(/\s{2,}/g, ' ')
}

export function readingMinutes(words: number): number {
  return Math.max(1, Math.round(words / 300))
}

export function slugifyHeading(text: string): string {
  return (
    text
      .trim()
      .toLowerCase()
      .replace(/[\s\u3000]+/g, '-')
      .replace(/[!-/:-@[-`{-~\uff01-\uff5e\uff0c\u3002\u3001\uff1b\uff1a\uff1f\uff08\uff09\u3010\u3011\u300c\u300d\u300e\u300f]/g, '')
      .replace(/-{2,}/g, '-')
      .replace(/^-+|-+$/g, '') || 'section'
  )
}
