/**
 * The grammar half of the QuickAdd token language: how a `{{...}}` span is found and what its
 * name and options mean. No prompting, no clock, no vault — every function here is a pure lookup
 * so the settings editor can validate and preview a format without running anything.
 *
 * The reference plugin gives each token family its own regular expression. Nine of those
 * expressions had to carry hand-written anti-backtracking clauses (their comments cite #1455 and
 * #1907 for two freezes caused by unterminated `{{` runs), so this file instead scans the literal
 * `{{` … `}}` span once and dispatches on the token's name. Unterminated openers then cost one
 * linear scan for the whole string rather than one quadratic match attempt per family.
 */

export type QuickAddTokenName =
  | 'value'
  | 'name'
  | 'date'
  | 'time'
  | 'vdate'
  | 'title'
  | 'linkcurrent'
  | 'linksection'
  | 'filenamecurrent'
  | 'folder'
  | 'foldercurrent'
  | 'selected'
  | 'clipboard'
  | 'random'
  | 'mvalue'
  | 'property'
  | 'macro'
  | 'template'
  | 'globalvar'
  | 'field'
  | 'file'
  | 'periodic'
  | 'cursor'
  | 'unknown'

export const QUICKADD_TOKEN_NAMES = [
  'value', 'name', 'date', 'time', 'vdate', 'title', 'linkcurrent', 'linksection',
  'filenamecurrent', 'folder', 'foldercurrent', 'selected', 'clipboard', 'random',
  'mvalue', 'property', 'macro', 'template', 'globalvar', 'field', 'file', 'periodic', 'cursor',
] as const

const NAME_BY_KEYWORD: Readonly<Record<string, QuickAddTokenName>> = {
  VALUE: 'value',
  NAME: 'name',
  DATE: 'date',
  TIME: 'time',
  VDATE: 'vdate',
  TITLE: 'title',
  LINKCURRENT: 'linkcurrent',
  LINKSECTION: 'linksection',
  FILENAMECURRENT: 'filenamecurrent',
  FOLDER: 'folder',
  FOLDERCURRENT: 'foldercurrent',
  SELECTED: 'selected',
  CLIPBOARD: 'clipboard',
  RANDOM: 'random',
  MVALUE: 'mvalue',
  PROPERTY: 'property',
  MACRO: 'macro',
  TEMPLATE: 'template',
  GLOBAL_VAR: 'globalvar',
  FIELD: 'field',
  FILE: 'file',
  DAILY: 'periodic',
  WEEKLY: 'periodic',
  MONTHLY: 'periodic',
  QUARTERLY: 'periodic',
  YEARLY: 'periodic',
  CURSOR: 'cursor',
}

export const PERIODIC_KEYWORDS = ['DAILY', 'WEEKLY', 'MONTHLY', 'QUARTERLY', 'YEARLY'] as const
export type PeriodicKeyword = (typeof PERIODIC_KEYWORDS)[number]

export interface TokenSpan {
  /** Offset of `{{` in the text the scan started from. */
  start: number
  /** Offset just past the matching `}}`. */
  end: number
  raw: string
  name: QuickAddTokenName
  /** The keyword as written, upper-cased: `DAILY`, `VALUE`, … */
  keyword: string
  /**
   * Everything after the keyword as written: `+7:YYYY|MM|case:upper`, `:Red,Green|custom`, or
   * `|label:Pick`. Each family's parser decides what the leading `:` or `|` means.
   */
  rest: string
}

/**
 * The `{{ … }}` spans of a text, in order, each with its parsed name.
 *
 * A span ends at the first `}}` on the same line that is not inside a `[literal]` run; a `{` inside
 * the span means the author opened a nested token, which is not part of this language, so the span
 * is not a token at all and scanning resumes just past the opener. An unclosed `{{` costs one scan
 * and is returned as literal text by the caller.
 */
export function scanTokens(text: string): TokenSpan[] {
  const spans: TokenSpan[] = []
  let index = 0
  while (index < text.length) {
    const open = text.indexOf('{{', index)
    if (open === -1) break
    const close = findSpanEnd(text, open + 2)
    if (close === -1) {
      index = open + 2
      continue
    }
    const raw = text.slice(open, close)
    const parsed = parseSpan(raw)
    if (parsed) spans.push({ ...parsed, start: open, end: close, raw })
    index = close
  }
  return spans
}

function findSpanEnd(text: string, from: number): number {
  let inLiteral = false
  for (let index = from; index < text.length; index += 1) {
    const char = text[index]
    if (char === '\n' || char === '\r') return -1
    if (char === '{') return -1
    if (char === '[' && !inLiteral) {
      inLiteral = true
      continue
    }
    if (char === ']' && inLiteral) {
      inLiteral = false
      continue
    }
    if (inLiteral) continue
    if (char === '}' && text[index + 1] === '}') return index + 2
  }
  return -1
}

function parseSpan(raw: string): Omit<TokenSpan, 'start' | 'end' | 'raw'> | null {
  const body = raw.slice(2, -2)
  if (!body.trim()) return null
  const keywordMatch = /^[ \t]*([A-Za-z_]+)/.exec(body)
  const keyword = keywordMatch?.[1].toUpperCase() ?? ''
  const rest = body.slice((keywordMatch?.index ?? 0) + (keywordMatch?.[0].length ?? 0))
  const name = NAME_BY_KEYWORD[keyword]
  if (!name) return { name: 'unknown', keyword, rest }
  if (name !== 'date' && name !== 'time' && name !== 'periodic' && /^\s*[+-]\d/.test(rest))
    return { name: 'unknown', keyword, rest }
  return { name, keyword, rest }
}

/** The token body with its leading `:` or `|` removed, for the families that have no format slot. */
export function bodyOf(span: TokenSpan): string {
  return span.rest.replace(/^[ \t]*[:|]/, '')
}

/** Every span of a given keyword, e.g. all `{{DAILY}}`-family tokens in a capture target. */
export function tokensNamed(spans: readonly TokenSpan[], ...names: QuickAddTokenName[]): TokenSpan[] {
  return spans.filter((span) => names.includes(span.name))
}

/** Pipe-separated parts of a token body, keeping `[literal]` runs and `"quoted"` parts intact. */
export function splitPipes(body: string): string[] {
  const parts: string[] = []
  let current = ''
  let inLiteral = false
  let inQuotes = false
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index]
    if (char === '"' && body[index - 1] !== '\\') inQuotes = !inQuotes
    if (!inQuotes) {
      if (char === '[' && !inLiteral) inLiteral = true
      else if (char === ']' && inLiteral) inLiteral = false
    }
    if (char === '|' && !inLiteral && !inQuotes) {
      parts.push(current)
      current = ''
      continue
    }
    current += char
  }
  parts.push(current)
  return parts
}

/** A comma list that may quote its items, so `"a, b"` stays one option. */
export function splitOptionList(value: string): string[] {
  const items: string[] = []
  let current = ''
  let inQuotes = false
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]
    if (char === '"' && value[index - 1] !== '\\') {
      inQuotes = !inQuotes
      continue
    }
    if ((char === ',' || char === '\uFF0C' || char === '\u3001') && !inQuotes) {
      items.push(current.trim())
      current = ''
      continue
    }
    current += char
  }
  items.push(current.trim())
  return items.filter((item) => item !== '')
}

export type ValueInputType = 'text' | 'multiline' | 'number' | 'slider' | 'checkbox' | 'date'

export interface NumericBounds {
  min?: number
  max?: number
  step?: number
}

/** `{{VALUE}}`, `{{NAME}}` and their property/prompt forms. */
export interface ParsedValueToken {
  /** The part before the first pipe: a label, a comma list, or empty for the anonymous token. */
  variableName: string
  /** Where the answer is stored; `value` for the anonymous token. */
  variableKey: string
  label: string
  options: string[]
  displayOptions: string[] | null
  hasOptions: boolean
  allowCustomInput: boolean
  defaultValue: string
  inputType: ValueInputType | null
  numeric: NumericBounds
  caseStyle: string | null
  optional: boolean
  trim: boolean
  multiSelect: boolean
  multiFormat: 'auto' | 'inline' | 'spaced' | 'yaml' | 'markdown' | 'linklist'
  confirm: boolean
}

const VALUE_OPTION_KEYS = new Set([
  'label', 'default', 'custom', 'type', 'case', 'text', 'optional', 'trim', 'multi', 'format', 'name',
  'min', 'max', 'step',
])

const INPUT_TYPES = new Set<ValueInputType>(['text', 'multiline', 'number', 'slider', 'checkbox', 'date'])

function parseKeyValue(part: string): { key: string; value: string } | null {
  const at = part.indexOf(':')
  if (at <= 0) return null
  const key = part.slice(0, at).trim().toLowerCase()
  if (!key || !/^[a-z_-]+$/.test(key)) return null
  const raw = part.slice(at + 1).trim()
  return { key, value: raw.startsWith('"') && raw.endsWith('"') && raw.length > 1 ? raw.slice(1, -1) : raw }
}

function numericBoundsOf(value: string): number | undefined {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

/**
 * Parse the body of a `{{VALUE:...}}` / `{{NAME:...}}` token.
 *
 * Two grammars share this function, the way the reference's do: with no `key:value` part at all the
 * tail is the *default text* (the old form), and with one, the tail is a set of options. That is why
 * `{{VALUE:Red,Green|custom}}` offers a suggester while `{{VALUE:My note}}` prompts for a title.
 */
export function parseValueToken(body: string): ParsedValueToken {
  const parts = splitPipes(body)
  const head = (parts.shift() ?? '').trim()
  const bare = parts.map((part) => part.trim()).filter((part) => part !== '')

  const options = splitOptionList(head)
  const hasOptions = options.length > 1
  const usesKeys = parts.some((part) => parseKeyValue(part) && VALUE_OPTION_KEYS.has(parseKeyValue(part)!.key))

  const token: ParsedValueToken = {
    variableName: head,
    variableKey: head.toLowerCase() === 'value' || head === '' ? 'value' : head,
    label: head,
    options: hasOptions ? options : [],
    displayOptions: null,
    hasOptions,
    allowCustomInput: false,
    defaultValue: usesKeys ? '' : (parts.join('|') || '').trim(),
    inputType: null,
    numeric: {},
    caseStyle: null,
    optional: false,
    trim: false,
    multiSelect: false,
    multiFormat: 'auto',
    confirm: false,
  }

  if (!usesKeys) {
    if (hasOptions && /(^|\|)\s*custom\s*($|\|)/i.test(`|${body.split('|').slice(1).join('|')}|`))
      token.allowCustomInput = true
    if (hasOptions && /(^|\|)\s*multi\s*($|\|)/i.test(`|${body.split('|').slice(1).join('|')}|`)) token.multiSelect = true
    if (hasOptions && token.allowCustomInput) token.defaultValue = ''
    token.variableKey = hasOptions ? `${head}\u001F` : head || 'value'
    return token
  }

  for (const part of bare) {
    const bareLower = part.toLowerCase()
    if (hasOptions && bareLower === 'custom') {
      token.allowCustomInput = true
      continue
    }
    if (hasOptions && bareLower === 'multi') {
      token.multiSelect = true
      continue
    }
    if (bareLower === 'optional') {
      token.optional = true
      continue
    }
    if (bareLower === 'trim') {
      token.trim = true
      continue
    }
    const option = parseKeyValue(part)
    if (!option || !VALUE_OPTION_KEYS.has(option.key)) continue
    switch (option.key) {
      case 'label':
        if (option.value) {
          token.label = option.value
          token.variableKey = hasOptions ? `${head}\u001F${option.value}` : head || 'value'
        }
        break
      case 'default':
        token.defaultValue = option.value
        break
      case 'case':
        token.caseStyle = option.value.toLowerCase()
        break
      case 'text':
        if (hasOptions) {
          const displays = splitOptionList(option.value)
          if (displays.length === options.length) token.displayOptions = displays
        }
        break
      case 'name':
        if (option.value) token.variableKey = hasOptions && token.label !== head
          ? `${option.value}\u001F${token.label}`
          : option.value
        break
      case 'multi':
        token.multiSelect = option.value.toLowerCase() !== 'false'
        break
      case 'format':
        if (['auto', 'inline', 'spaced', 'yaml', 'markdown', 'linklist'].includes(option.value.toLowerCase()))
          token.multiFormat = option.value.toLowerCase() as ParsedValueToken['multiFormat']
        break
      case 'type': {
        const requested = option.value.toLowerCase()
        const normalized = requested === 'boolean' ? 'checkbox' : requested === 'text' ? 'text' : requested
        if (INPUT_TYPES.has(normalized as ValueInputType) && !hasOptions)
          token.inputType = normalized as ValueInputType
        break
      }
      case 'min':
        token.numeric.min = numericBoundsOf(option.value)
        break
      case 'max':
        token.numeric.max = numericBoundsOf(option.value)
        break
      case 'step':
        token.numeric.step = numericBoundsOf(option.value)
        break
      default:
        break
    }
  }

  if (token.multiSelect && !hasOptions) token.multiSelect = false
  if (token.inputType === 'date') token.inputType = 'date'
  return token
}

export interface ParsedDateToken {
  format: string | null
  offset: number
  snap: { boundary: 'start' | 'end'; unit: string } | null
  caseStyle: string | null
  /** A snap unit the author misspelled: reported instead of thrown, so a capture still runs. */
  badUnit: string | null
  /** The body is not in this grammar at all, so the token must stay exactly as written. */
  bad: boolean
}

const SNAP_UNITS: Readonly<Record<string, string>> = {
  year: 'year', years: 'year', y: 'year',
  quarter: 'quarter', quarters: 'quarter', q: 'quarter',
  month: 'month', months: 'month',
  week: 'week', weeks: 'week', w: 'week',
  isoweek: 'isoweek', isoweeks: 'isoweek',
  day: 'day', days: 'day', d: 'day',
  hour: 'hour', hours: 'hour',
  minute: 'minute', minutes: 'minute',
}

/**
 * A day shift is written `+7` or `+-7`, in front of the format or at its end. A bare `-7` is not a
 * shift, because a format legitimately ends in a minus and its digits: `{{DATE:YYYY-07-01}}`.
 */
const LEADING_OFFSET_RE = /^\s*\+(-?\d+)\s*/
const TRAILING_OFFSET_RE = /\+(-?\d+)$/

/**
 * Split a `DATE`/`TIME` body into format, day offset, snap and case.
 *
 * Modifiers are read from the END, one at a time, because a pipe is legal inside a date pattern
 * (`YYYY|MM` renders a literal pipe). Only a tail that names a known modifier is taken as one, which
 * is the rule the reference encodes with two negative lookaheads in a much longer expression.
 */
export function parseDateToken(rest: string): ParsedDateToken {
  const result: ParsedDateToken = { format: null, offset: 0, snap: null, caseStyle: null, badUnit: null, bad: false }
  let text = rest

  const leading = LEADING_OFFSET_RE.exec(text)
  if (leading) {
    result.offset = Math.trunc(Number(leading[1]))
    text = text.slice(leading[0].length)
  }

  const hasFormatSlot = /^\s*:/.test(text)
  if (hasFormatSlot) text = text.replace(/^\s*:/, '')

  const pipes = splitPipes(text)
  let consumed = 0
  for (let index = pipes.length - 1; index >= (hasFormatSlot ? 1 : 0); index -= 1) {
    const option = parseKeyValue(pipes[index])
    // One snap, one case, each terminal. The asymmetry is the reference's own: its format class
    // forbids a pipe before `case:` only when that is the LAST modifier, so an earlier `|case:upper`
    // stays literal, while ANY pipe before `startof:`/`endof:` is un-formattable — a second snap
    // therefore fails the whole token rather than silently dropping the author's literal.
    if (option?.key === 'case' && option.value) {
      if (result.caseStyle) break
      result.caseStyle = option.value.toLowerCase()
      consumed += 1
      continue
    }
    if (option && (option.key === 'startof' || option.key === 'endof')) {
      if (result.snap) break
      const unit = SNAP_UNITS[option.value.toLowerCase()]
      if (!unit && !result.badUnit) result.badUnit = option.value
      result.snap = unit ? { boundary: option.key === 'startof' ? 'start' : 'end', unit } : null
      consumed += 1
      continue
    }
    break
  }

  let format = pipes.slice(0, pipes.length - consumed).join('|')
  if (!hasFormatSlot) {
    if (format.trim() !== '') result.bad = true
    return result
  }
  if (/(?:^|\|)\s*(?:startof|endof):/.test(format)) {
    result.bad = true
    result.snap = null
    return result
  }

  // The other place a shift may sit: at the end of the format, outside a `[literal]` run.
  const outsideLiterals = format.replace(/\[[^\]]*\]/g, (match) => ' '.repeat(match.length))
  const trailing = TRAILING_OFFSET_RE.exec(outsideLiterals)
  if (trailing) {
    result.offset = Math.trunc(Number(trailing[1]))
    format = format.slice(0, format.length - trailing[1].length - 1)
  }
  if (format.trim() !== '') result.format = format
  return result
}

export interface ParsedVDateToken {
  name: string
  format: string | null
  withTime: boolean
  defaultValue: string
  optional: boolean
  snap: { boundary: 'start' | 'end'; unit: string } | null
  caseStyle: string | null
}

/** `{{VDATE:name, format|options}}` — a named date the run asks for once and reuses. */
export function parseVDateToken(body: string): ParsedVDateToken {
  const [head = '', ...tail] = splitPipes(body)
  const [name = '', ...formatParts] = head.split(',')
  const format = formatParts.join(',').trim()
  const token: ParsedVDateToken = {
    name: name.trim(),
    format: format || null,
    withTime: false,
    defaultValue: '',
    optional: false,
    snap: null,
    caseStyle: null,
  }
  for (const part of tail.map((item) => item.trim())) {
    const lower = part.toLowerCase()
    if (lower === 'optional') token.optional = true
    if (lower === 'time' || lower === 'datetime') token.withTime = true
    const option = parseKeyValue(part)
    if (!option) continue
    if (option.key === 'default') token.defaultValue = option.value
    if (option.key === 'case') token.caseStyle = option.value.toLowerCase()
    if ((option.key === 'startof' || option.key === 'endof') && SNAP_UNITS[option.value.toLowerCase()])
      token.snap = { boundary: option.key === 'startof' ? 'start' : 'end', unit: SNAP_UNITS[option.value.toLowerCase()] }
  }
  return token
}

export interface ParsedFieldToken {
  fieldName: string
  label: string | null
  folder: string | null
  tag: string | null
  excludeTag: string | null
  path: string | null
  inline: boolean
  multiSelect: boolean
  multiFormat: ParsedValueToken['multiFormat']
  defaultValue: string
  caseSensitive: boolean
}

/** `{{FIELD:property|folder:X|tag:Y|…}}` — values collected from the account's other notes. */
export function parseFieldToken(body: string): ParsedFieldToken {
  const parts = splitPipes(body)
  const token: ParsedFieldToken = {
    fieldName: (parts.shift() ?? '').trim(),
    label: null,
    folder: null,
    tag: null,
    excludeTag: null,
    path: null,
    inline: false,
    multiSelect: false,
    multiFormat: 'auto',
    defaultValue: '',
    caseSensitive: false,
  }
  for (const part of parts.map((item) => item.trim())) {
    const lower = part.toLowerCase()
    if (lower === 'multi') token.multiSelect = true
    if (lower === 'inline') token.inline = true
    const option = parseKeyValue(part)
    if (!option) continue
    switch (option.key) {
      case 'label': token.label = option.value; break
      case 'folder': token.folder = option.value; break
      case 'tag': token.tag = option.value; break
      case 'exclude-tag': token.excludeTag = option.value; break
      case 'path': token.path = option.value; break
      case 'default': token.defaultValue = option.value; break
      case 'case-sensitive': token.caseSensitive = option.value.toLowerCase() !== 'false'; break
      case 'format':
        if (['inline', 'spaced', 'yaml', 'markdown', 'linklist'].includes(option.value.toLowerCase()))
          token.multiFormat = option.value.toLowerCase() as ParsedFieldToken['multiFormat']
        break
      default: break
    }
  }
  return token
}

export interface ParsedFileToken {
  folder: string
  mode: 'name' | 'path' | 'link'
  types: string[]
  label: string | null
  aliasName: string | null
  allowCustomInput: boolean
  multiSelect: boolean
  optional: boolean
}

const FILE_MODES = new Set(['name', 'path', 'link'])

/** `{{FILE:folder|path|link|type:md|custom|multi}}` — pick one of the account's notes. */
export function parseFileToken(body: string): ParsedFileToken {
  const parts = splitPipes(body).map((part) => part.trim())
  const folder = parts.shift() ?? ''
  const token: ParsedFileToken = {
    folder,
    mode: 'name',
    types: [],
    label: null,
    aliasName: null,
    allowCustomInput: false,
    multiSelect: false,
    optional: false,
  }
  for (const part of parts) {
    const lower = part.toLowerCase()
    if (FILE_MODES.has(lower)) token.mode = lower as ParsedFileToken['mode']
    else if (lower === 'custom') token.allowCustomInput = true
    else if (lower === 'multi') token.multiSelect = true
    else if (lower === 'optional') token.optional = true
    const option = parseKeyValue(part)
    if (!option) continue
    if (option.key === 'label') token.label = option.value
    if (option.key === 'name') token.aliasName = option.value
    if (option.key === 'type') token.types = splitOptionList(option.value).map((item) => item.toLowerCase())
  }
  return token
}

export interface ParsedMacroToken {
  name: string
  label: string | null
}

export function parseMacroToken(body: string): ParsedMacroToken {
  const parts = splitPipes(body).map((part) => part.trim())
  const name = parts.shift() ?? ''
  let label: string | null = null
  for (const part of parts) {
    const option = parseKeyValue(part)
    if (option?.key === 'label') label = option.value
  }
  return { name, label }
}

/** `{{DAILY}}`, `{{WEEKLY|link}}`, `{{DAILY+1}}`, `{{DAILY+1|link}}`. */
export function parsePeriodicToken(rest: string, keyword: string): { period: PeriodicKeyword; link: boolean; offset: number } {
  let link = false
  let offset = 0
  const body = rest.replace(/^[ \t]*[:|]/, '')
  for (const part of [body, ...splitPipes(body)]) {
    const lower = (part ?? '').trim().toLowerCase()
    if (!lower) continue
    if (lower === 'link') link = true
    const offsetMatch = /^([+-]\d+)$/.exec(lower)
    if (offsetMatch) offset = Math.trunc(Number(offsetMatch[1]))
  }
  return { period: keyword as PeriodicKeyword, link, offset }
}

export function randomLengthOf(body: string): number | null {
  const parsed = Number((body ?? '').trim())
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 100 ? parsed : null
}

/** The random alphabet the reference uses: base62, no symbols. */
const RANDOM_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'

export function randomString(length: number, random: () => number = Math.random): string {
  let out = ''
  for (let index = 0; index < length; index += 1)
    out += RANDOM_ALPHABET[Math.min(RANDOM_ALPHABET.length - 1, Math.floor(random() * RANDOM_ALPHABET.length))]
  return out
}

export const CASE_STYLES = ['kebab', 'snake', 'camel', 'pascal', 'title', 'lower', 'upper', 'slug'] as const

function tokenizeWords(input: string): string[] {
  return input
    .split(/[^\p{L}\p{N}\p{M}]+/u)
    .flatMap((segment) => {
      if (!segment) return []
      const brand = /^([\p{Ll}][\p{Lu}]{2,})([\p{N}]+)?$/u.exec(segment)
      if (brand) return brand[2] ? [brand[1], brand[2]] : [brand[1]]
      if (/^[\p{Ll}][\p{Lu}][\p{Ll}]+(?:[\p{Lu}][\p{Ll}]+)*$/u.test(segment)) return [segment]
      let text = segment
      text = text.replace(/([\p{Lu}])([\p{Lu}][\p{Ll}])/gu, '$1 $2')
      text = text.replace(/([\p{Ll}\p{N}])([\p{Lu}])/gu, '$1 $2')
      text = text.replace(/([\p{L}])([\p{N}])/gu, '$1 $2')
      text = text.replace(/([\p{N}])([\p{L}])/gu, '$1 $2')
      return text.trim().split(/\s+/u).filter(Boolean)
    })
    .filter(Boolean)
}

function isAllCaps(word: string): boolean {
  return /\p{Lu}/u.test(word) && !/\p{Ll}/u.test(word)
}

function isMixedCase(word: string): boolean {
  return /\p{Lu}/u.test(word) && /\p{Ll}/u.test(word)
}

function upperFirst(word: string): string {
  const lower = word.toLowerCase()
  return lower.slice(0, 1).toUpperCase() + lower.slice(1)
}

/**
 * `|case:` styles. An unknown style returns the text unchanged rather than throwing, because a
 * typo in a saved choice must not stop a capture that would otherwise work; the settings editor
 * flags the style instead.
 */
export function applyCaseStyle(input: string, style: string | null | undefined): string {
  if (!style) return input
  const normalized = style.trim().toLowerCase()
  if (normalized === 'lower') return input.toLowerCase()
  if (normalized === 'upper') return input.toUpperCase()
  const words = tokenizeWords(input)
  // Nothing to rebuild, so nothing to write: an all-punctuation answer becomes empty rather than
  // keeping punctuation the style would have had to place between words.
  if (words.length === 0) return ''
  switch (normalized) {
    case 'kebab':
      return words.map((word) => word.toLowerCase()).join('-')
    case 'snake':
      return words.map((word) => word.toLowerCase()).join('_')
    case 'slug':
      return words.map((word) => word.toLowerCase()).join('-')
    case 'camel': {
      const [first, ...rest] = words
      return [
        first && !isMixedCase(first) ? first.toLowerCase() : first,
        ...rest.map((word) => (isAllCaps(word) || isMixedCase(word) ? word : upperFirst(word))),
      ].join('')
    }
    case 'pascal':
      return words.map((word) => (isAllCaps(word) || isMixedCase(word) ? word : upperFirst(word))).join('')
    case 'title':
      return words.map((word) => (isAllCaps(word) || isMixedCase(word) ? word : upperFirst(word))).join(' ')
    default:
      return input
  }
}

export function isKnownCaseStyle(style: string): boolean {
  return (CASE_STYLES as readonly string[]).includes(style.trim().toLowerCase())
}

/**
 * What `{{MACRO:}}`, `{{TEMPLATE:}}` and `{{GLOBAL_VAR:}}` name: a bare keyword before the first
 * pipe, so `{{TEMPLATE:Daily}}` and `{{TEMPLATE:Daily|label:Pick}}` both name `Daily`.
 */
export function namedReference(body: string): { name: string; label: string | null } {
  const parts = splitPipes(body ?? '').map((part) => part.trim())
  const name = parts.shift() ?? ''
  let label: string | null = null
  for (const part of parts) {
    const option = parseKeyValue(part)
    if (option?.key === 'label') label = option.value
  }
  return { name, label }
}
