/**
 * The QuickAdd format engine: one `{{ token }}` pass at a time, in the order the language promises.
 *
 * Two rules shape everything below. First, a stage replaces its own tokens and copies the rest of
 * the text verbatim, so an answer that happens to look like a token cannot be expanded a second
 * time — the failure the reference plugin hit when a note was literally named `{{value}}`. Second,
 * the stages run in a fixed order (globals → escapes → macros → includes → dates → prompts → data →
 * current-file tokens), so text injected by an earlier stage *can* be expanded by a later one,
 * which is what makes a global snippet or an included template useful.
 */
import {
  parseDateToken,
  parseFieldToken,
  parseFileToken,
  parsePeriodicToken,
  parseValueToken,
  parseVDateToken,
  randomLengthOf,
  randomString,
  applyCaseStyle,
  bodyOf,
  namedReference,
  scanTokens,
  type ParsedFieldToken,
  type ParsedFileToken,
  type ParsedValueToken,
  type TokenSpan,
} from './token-grammar'
import { formatDatePattern } from './date-pattern'
import { weekStartFor } from '../time'
import { evaluateMathExpression, formatMathValue } from './math'
import type { QuickAddPeriod } from '@shared/quickadd'

export type PromptKind =
  | 'text' | 'multiline' | 'number' | 'slider' | 'checkbox' | 'date' | 'suggester' | 'confirm' | 'math'

export type PromptAnswer = string | string[] | null

export interface PromptRequest {
  kind: PromptKind
  /** The variable the answer is stored under, so a second occurrence reuses it. */
  key: string
  label: string
  defaultValue: string
  options: string[]
  displayOptions: string[] | null
  allowCustom: boolean
  multiSelect: boolean
  multiFormat: ParsedValueToken['multiFormat']
  optional: boolean
  trim: boolean
  caseStyle: string | null
  numeric: ParsedValueToken['numeric']
  /** Only for kind `date`: the pattern the answer is rendered with. */
  dateFormat: string | null
  /** Only for kind `date`: the answer may carry a time of day. */
  withTime: boolean
}

export interface FormatRuntime {
  variables: Map<string, PromptAnswer>
  globalVars: ReadonlyMap<string, string>
  locale: string
  /** `now` is the clock; `date` is the calendar day every date token is measured from. */
  clock: { now: Date; date: Date }
  defaults: { dateFormat: string; timeFormat: string }
  title: string | null
  folderPath: string | null
  activeTitle: string | null
  activeFolderPath: string | null
  selection: string
  clipboard: () => Promise<string>
  linkToActive: (subpath: string | null) => string | null
  cursorHeadingPath: () => string | null
  prompt: (request: PromptRequest) => Promise<PromptAnswer>
  templateBody: (name: string) => Promise<string | null>
  runMacroByName: (name: string, label: string | null) => Promise<string>
  fieldValues: (token: ParsedFieldToken) => Promise<string[]>
  pickFile: (token: ParsedFileToken) => Promise<PromptAnswer>
  periodicPath: (period: QuickAddPeriod, offset: number, link: boolean) => string
  /** A message the surface can show without aborting the run: a misspelled snap unit, say. */
  warn: (message: string) => void
}

/**
 * A runtime where a macro or an included template expands once per run, no matter how many times the
 * text is formatted. `{{MVALUE}}` asks once and gives every line the same answer, and a macro with a
 * side effect does not repeat it for each line of a one-entry-per-line capture — but a `{{DATE}}` or
 * `{{RANDOM:}}` in that same text still resolves afresh, which is what each line is asking for.
 */
export function memoizeStructure(runtime: FormatRuntime): FormatRuntime {
  const macros = new Map<string, string>()
  const templates = new Map<string, string | null>()
  return {
    ...runtime,
    runMacroByName: async (name, label) => {
      const key = name.trim().toLowerCase()
      const cached = macros.get(key)
      if (cached !== undefined) return cached
      const expanded = await runtime.runMacroByName(name, label)
      macros.set(key, expanded)
      return expanded
    },
    templateBody: async (name) => {
      if (templates.has(name)) return templates.get(name) ?? null
      const body = await runtime.templateBody(name)
      templates.set(name, body)
      return body
    },
  }
}

export interface FormattedText {
  text: string
  /** Caret offset inside `text`, from the first `{{cursor}}`, or null. */
  cursor: number | null
}

const PERIOD_TO_QUICKADD_PERIOD: Readonly<Record<string, QuickAddPeriod>> = {
  DAILY: 'daily',
  WEEKLY: 'weekly',
  MONTHLY: 'monthly',
  QUARTERLY: 'quarterly',
  YEARLY: 'yearly',
}

async function mapTokens(
  text: string,
  replace: (span: TokenSpan) => Promise<string | null> | string | null,
): Promise<string> {
  const spans = scanTokens(text)
  let out = ''
  let at = 0
  for (const span of spans) {
    const value = await replace(span)
    if (value === null) continue
    out += text.slice(at, span.start) + value
    at = span.end
  }
  return `${out}${text.slice(at)}`
}

/** Case-insensitive variable lookup: exact first, then a unique match, the reference's rule. */
export function readVariable(
  variables: ReadonlyMap<string, PromptAnswer>,
  key: string,
): { key: string; value: PromptAnswer } | null {
  if (variables.has(key)) return { key, value: variables.get(key) ?? null }
  const lower = key.toLowerCase()
  const matches: string[] = []
  for (const existing of variables.keys()) {
    if (existing.toLowerCase() === lower && variables.get(existing) !== undefined) matches.push(existing)
  }
  if (matches.length !== 1) return null
  return { key: matches[0], value: variables.get(matches[0]) ?? null }
}

function renderAnswer(value: PromptAnswer, token: PromptRequest): string {
  if (Array.isArray(value)) {
    const items = value.map((item) => (token.trim ? item.trim() : item)).filter((item) => item !== '')
    const formatted = items.map((item) => applyCaseStyle(item, token.caseStyle))
    switch (token.multiFormat) {
      case 'yaml':
        return `[${formatted.join(', ')}]`
      case 'markdown':
        return formatted.map((item) => `[[${item}]]`).join(', ')
      case 'linklist':
        return formatted.map((item) => `[[${item}]]`).join(' ')
      case 'inline':
        return formatted.join('')
      case 'spaced':
        return formatted.join(' ')
      default:
        return formatted.join(', ')
    }
  }
  const raw = value === null ? '' : token.trim ? value.trim() : value
  return applyCaseStyle(raw, token.caseStyle)
}

async function answerFor(runtime: FormatRuntime, request: PromptRequest): Promise<PromptAnswer> {
  const known = readVariable(runtime.variables, request.key)
  if (known && known.value !== null && known.value !== undefined) return known.value
  const answer = await runtime.prompt(request)
  if (answer !== null) runtime.variables.set(request.key, answer)
  return answer
}

function valueRequest(span: TokenSpan, runtime: FormatRuntime, scopeHint: string): PromptRequest {
  const parsed = parseValueToken(bodyOf(span))
  const label = parsed.hasOptions ? parsed.label : parsed.variableName || scopeHint
  const seeded = readVariable(runtime.variables, parsed.variableName || 'value')
  const defaultText = typeof seeded?.value === 'string' && seeded.value !== '' ? seeded.value : parsed.defaultValue
  const kind: PromptKind = parsed.inputType
    ?? (parsed.hasOptions ? 'suggester' : 'text')
  return {
    kind: parsed.multiSelect ? 'suggester' : kind,
    key: parsed.variableKey,
    label: label || parsed.variableName,
    defaultValue: defaultText,
    options: parsed.options,
    displayOptions: parsed.displayOptions,
    allowCustom: parsed.allowCustomInput,
    multiSelect: parsed.multiSelect,
    multiFormat: parsed.multiFormat,
    optional: parsed.optional,
    trim: parsed.trim,
    caseStyle: parsed.caseStyle,
    numeric: parsed.numeric,
    dateFormat: null,
    withTime: false,
  }
}

/**
 * The inputs a format will ask for, in the order they appear. The one-page form and the settings
 * preview both read this, so the form can never promise a prompt the engine then skips (or miss one
 * it asks for): the discovery and the run go through the same parser and the same variable keys.
 */
export function collectRequirements(text: string, runtime: FormatRuntime): PromptRequest[] {
  const found: PromptRequest[] = []
  const seen = new Set<string>()
  const push = (request: PromptRequest): void => {
    if (seen.has(request.key.toLowerCase())) return
    seen.add(request.key.toLowerCase())
    found.push(request)
  }
  for (const span of scanTokens(expandGlobalsForDiscovery(text, runtime))) {
    switch (span.name) {
      case 'value':
      case 'name': {
        const request = valueRequest(span, runtime, span.name === 'name' ? 'Name' : 'Value')
        if (readVariable(runtime.variables, request.key)) break
        push(request)
        break
      }
      case 'vdate': {
        const parsed = parseVDateToken(bodyOf(span))
        if (!parsed.name || readVariable(runtime.variables, parsed.name)) break
        push({
          kind: 'date',
          key: parsed.name,
          label: parsed.name,
          defaultValue: parsed.defaultValue,
          options: [],
          displayOptions: null,
          allowCustom: false,
          multiSelect: false,
          multiFormat: 'auto',
          optional: parsed.optional,
          trim: false,
          caseStyle: parsed.caseStyle,
          numeric: {},
          dateFormat: parsed.format ?? runtime.defaults.dateFormat,
          withTime: parsed.withTime,
        })
        break
      }
      case 'field': {
        const parsed = parseFieldToken(bodyOf(span))
        if (!parsed.fieldName || readVariable(runtime.variables, `FIELD:${parsed.fieldName}`)) break
        push({
          kind: 'suggester',
          key: `FIELD:${parsed.fieldName}`,
          label: parsed.label ?? parsed.fieldName,
          defaultValue: parsed.defaultValue,
          options: [],
          displayOptions: null,
          allowCustom: true,
          multiSelect: parsed.multiSelect,
          multiFormat: parsed.multiFormat,
          optional: false,
          trim: false,
          caseStyle: null,
          numeric: {},
          dateFormat: null,
          withTime: false,
        })
        break
      }
      case 'file': {
        const parsed = parseFileToken(bodyOf(span))
        const key = parsed.aliasName ?? parsed.folder
        if (!key || readVariable(runtime.variables, key)) break
        push({
          kind: 'suggester',
          key,
          label: parsed.label ?? parsed.folder,
          defaultValue: '',
          options: [],
          displayOptions: null,
          allowCustom: parsed.allowCustomInput,
          multiSelect: parsed.multiSelect,
          multiFormat: 'auto',
          optional: parsed.optional,
          trim: false,
          caseStyle: null,
          numeric: {},
          dateFormat: null,
          withTime: false,
        })
        break
      }
      case 'mvalue':
        if (readVariable(runtime.variables, 'mvalue')) break
        push({
          kind: 'math',
          key: 'mvalue',
          label: 'Math expression',
          defaultValue: '',
          options: [],
          displayOptions: null,
          allowCustom: false,
          multiSelect: false,
          multiFormat: 'auto',
          optional: false,
          trim: false,
          caseStyle: null,
          numeric: {},
          dateFormat: null,
          withTime: false,
        })
        break
      default:
        break
    }
  }
  return found
}

function expandGlobalsForDiscovery(text: string, runtime: FormatRuntime): string {
  let output = text
  for (let pass = 0; pass < 4; pass += 1) {
    const next = mapTokensSync(output, (span) => {
      if (span.name !== 'globalvar') return null
      const { name } = namedReference(bodyOf(span))
      const value = runtime.globalVars.get(name)
      return value === undefined ? null : value
    })
    if (next === output) break
    output = next
  }
  return output
}

function mapTokensSync(text: string, replace: (span: TokenSpan) => string | null): string {
  let out = ''
  let at = 0
  for (const span of scanTokens(text)) {
    const value = replace(span)
    if (value === null) continue
    out += text.slice(at, span.start) + value
    at = span.end
  }
  return `${out}${text.slice(at)}`
}

/**
 * Expand `\n` and `\\` outside tokens. A token's interior keeps its backslashes, because a Moment
 * format writes a literal with `[...]` and an author's `\n` inside a `{{VALUE:…}}` label means
 * exactly what they typed.
 */
export function expandEscapes(text: string): string {
  const spans = scanTokens(text)
  let out = ''
  let at = 0
  let index = 0
  let spanAt = 0
  while (index < text.length) {
    while (spanAt < spans.length && spans[spanAt].start < index) spanAt += 1
    const span = spans[spanAt]?.start === index ? spans[spanAt] : undefined
    if (span) {
      out += text.slice(at, span.start) + span.raw
      index = span.end
      at = index
      continue
    }
    if (text[index] === '\\' && (text[index + 1] === 'n' || text[index + 1] === '\\')) {
      out += text.slice(at, index)
      out += text[index + 1] === 'n' ? '\n' : '\\'
      index += 2
      at = index
      continue
    }
    index += 1
  }
  return `${out}${text.slice(at)}`
}

export function snapDate(date: Date, snap: { boundary: 'start' | 'end'; unit: string }, locale: string): Date {
  const next = new Date(date.getTime())
  const weekStart = snap.unit === 'isoweek' ? 1 : weekStartFor(locale)
  switch (snap.unit) {
    case 'year':
      next.setFullYear(snap.boundary === 'start' ? next.getFullYear() : next.getFullYear(), snap.boundary === 'start' ? 0 : 11, 1)
      if (snap.boundary === 'end') next.setMonth(11, 31)
      break
    case 'quarter': {
      const firstMonth = Math.floor(next.getMonth() / 3) * 3
      next.setMonth(snap.boundary === 'start' ? firstMonth : firstMonth + 2)
      next.setDate(snap.boundary === 'start' ? 1 : new Date(next.getFullYear(), firstMonth + 3, 0).getDate())
      break
    }
    case 'month':
      next.setDate(1)
      if (snap.boundary === 'end') next.setMonth(next.getMonth() + 1, 0)
      break
    case 'week':
    case 'isoweek': {
      const day = (next.getDay() - weekStart + 7) % 7
      if (snap.boundary === 'start') next.setDate(next.getDate() - day)
      else next.setDate(next.getDate() + (6 - day))
      break
    }
    case 'day':
      if (snap.boundary === 'end') next.setHours(23, 59, 59, 999)
      else next.setHours(0, 0, 0, 0)
      break
    case 'hour':
      if (snap.boundary === 'end') next.setMinutes(59, 59, 999)
      else next.setMinutes(0, 0, 0)
      break
    case 'minute':
      if (snap.boundary === 'end') next.setSeconds(59, 999)
      else next.setSeconds(0, 0)
      break
    default:
      break
  }
  if (snap.boundary === 'start' && snap.unit !== 'day' && snap.unit !== 'hour' && snap.unit !== 'minute')
    next.setHours(0, 0, 0, 0)
  return next
}

function dateForOffset(origin: Date, now: Date, offset: number): Date {
  const value = new Date(origin.getTime())
  value.setHours(now.getHours(), now.getMinutes(), now.getSeconds(), now.getMilliseconds())
  if (offset) value.setDate(value.getDate() + offset)
  return value
}

/** A token pass that cannot ask anything: the settings preview and the error-free hint line. */
export function inertFormat(text: string, runtime: FormatRuntime): string {
  let output = expandGlobalsForDiscovery(text, runtime)
  output = expandEscapes(output)
  output = mapTokensSync(output, (span) => {
    switch (span.name) {
      case 'date': {
        const parsed = parseDateToken(span.rest)
        if (parsed.bad) return span.raw
        const origin = dateForOffset(runtime.clock.date, runtime.clock.now, parsed.offset)
        const snapped = parsed.snap ? snapDate(origin, parsed.snap, runtime.locale) : origin
        return applyCaseStyle(
          formatDatePattern(snapped, parsed.format ?? runtime.defaults.dateFormat, { locale: runtime.locale }),
          parsed.caseStyle,
        )
      }
      case 'time': {
        const parsed = parseDateToken(span.rest)
        if (parsed.bad) return span.raw
        return applyCaseStyle(
          formatDatePattern(runtime.clock.now, parsed.format ?? runtime.defaults.timeFormat, { locale: runtime.locale }),
          parsed.caseStyle,
        )
      }
      case 'periodic': {
        const parsed = parsePeriodicToken(span.rest, span.keyword)
        const period = PERIOD_TO_QUICKADD_PERIOD[parsed.period]
        return period ? runtime.periodicPath(period, parsed.offset, parsed.link) : span.raw
      }
      case 'value':
      case 'name': {
        const request = valueRequest(span, runtime, span.name === 'name' ? 'Name' : 'Value')
        const known = readVariable(runtime.variables, request.key)
        if (known && known.value !== null && known.value !== undefined) return renderAnswer(known.value, request)
        if (request.options.length > 0) return `{${request.options.join(' \| ')}}`
        return request.defaultValue ? `{${request.label}: ${request.defaultValue}}` : `{${request.label}}`
      }
      case 'vdate': {
        const parsed = parseVDateToken(bodyOf(span))
        if (!parsed.name) return span.raw
        const known = readVariable(runtime.variables, parsed.name)
        if (typeof known?.value === 'string')
          return renderStoredDate(known.value, parsed.format ?? runtime.defaults.dateFormat, parsed, runtime)
        return `{${parsed.name}: date}`
      }
      case 'field': {
        const parsed = parseFieldToken(bodyOf(span))
        return parsed.fieldName ? `{${parsed.label ?? parsed.fieldName}}` : span.raw
      }
      case 'file': {
        const parsed = parseFileToken(bodyOf(span))
        return parsed.folder ? `{${parsed.label ?? parsed.folder}}` : span.raw
      }
      case 'mvalue':
        return '{math}'
      case 'random': {
        const length = randomLengthOf(bodyOf(span))
        return length === null ? span.raw : 'a'.repeat(length)
      }
      case 'macro':
        return `{macro: ${namedReference(bodyOf(span)).name}}`
      case 'template':
        return `{template: ${namedReference(bodyOf(span)).name}}`
      case 'selected':
        return runtime.selection
      case 'clipboard':
        return '{clipboard}'
      case 'property':
        return renderAnswer(runtime.variables.get('propertyValue') ?? '', propertyRenderShape)
      default:
        return null
    }
  })
  output = mapTokensSync(output, (span) => {
    switch (span.name) {
      case 'title':
        return runtime.title ?? ''
      case 'linkcurrent':
        return runtime.linkToActive(null) ?? ''
      case 'linksection':
        return runtime.linkToActive(runtime.cursorHeadingPath()) ?? ''
      case 'filenamecurrent':
        return runtime.activeTitle ?? ''
      case 'folder':
        return runtime.folderPath ?? ''
      case 'foldercurrent':
        return runtime.activeFolderPath ?? ''
      default:
        return null
    }
  })
  return output
}

export async function formatQuickAddText(
  input: string,
  runtime: FormatRuntime,
  options: { preserveCursor?: boolean; propertyValue?: PromptAnswer } = {},
): Promise<FormattedText> {
  let text = expandGlobalsForDiscovery(input, runtime)
  text = expandEscapes(text)
  text = await mapTokens(text, async (span) => {
    if (span.name !== 'macro') return null
    const { name, label } = namedReference(bodyOf(span))
    if (!name) return ''
    return runtime.runMacroByName(name, label)
  })
  text = expandGlobalsForDiscovery(text, runtime)
  text = await includeTemplates(text, runtime)
  // A second pass: an included template or a macro may itself carry a `{{GLOBAL_VAR:}}` snippet.
  text = expandGlobalsForDiscovery(text, runtime)
  text = await mapTokens(text, async (span) => {
    switch (span.name) {
      case 'date': {
        const parsed = parseDateToken(span.rest)
        if (parsed.bad) return span.raw
        if (parsed.badUnit) runtime.warn(`unknown date unit "${parsed.badUnit}"`)
        const origin = dateForOffset(runtime.clock.date, runtime.clock.now, parsed.offset)
        const snapped = parsed.snap ? snapDate(origin, parsed.snap, runtime.locale) : origin
        return applyCaseStyle(
          formatDatePattern(snapped, parsed.format ?? runtime.defaults.dateFormat, { locale: runtime.locale }),
          parsed.caseStyle,
        )
      }
      case 'time': {
        const parsed = parseDateToken(span.rest)
        if (parsed.bad) return span.raw
        return applyCaseStyle(
          formatDatePattern(runtime.clock.now, parsed.format ?? runtime.defaults.timeFormat, { locale: runtime.locale }),
          parsed.caseStyle,
        )
      }
      case 'periodic': {
        const parsed = parsePeriodicToken(span.rest, span.keyword)
        const period = PERIOD_TO_QUICKADD_PERIOD[parsed.period]
        return period ? runtime.periodicPath(period, parsed.offset, parsed.link) : span.raw
      }
      default:
        return null
    }
  })

  text = await mapTokens(text, async (span) => {
    switch (span.name) {
      case 'value':
      case 'name': {
        const request = valueRequest(span, runtime, span.name === 'name' ? 'Name' : 'Value')
        const answer = await answerFor(runtime, request)
        return renderAnswer(answer ?? request.defaultValue ?? '', request)
      }
      case 'selected':
        return runtime.selection
      case 'clipboard':
        return await runtime.clipboard()
      case 'vdate': {
        const parsed = parseVDateToken(bodyOf(span))
        if (!parsed.name) return span.raw
        const dateFormat = parsed.format ?? runtime.defaults.dateFormat
        const answer = await answerFor(runtime, {
          kind: 'date',
          key: parsed.name,
          label: parsed.name,
          defaultValue: parsed.defaultValue,
          options: [],
          displayOptions: null,
          allowCustom: false,
          multiSelect: false,
          multiFormat: 'auto',
          optional: parsed.optional,
          trim: false,
          caseStyle: parsed.caseStyle,
          numeric: {},
          dateFormat,
          withTime: parsed.withTime,
        })
        const stored = typeof answer === 'string' ? answer : parsed.defaultValue
        return applyCaseStyle(renderStoredDate(stored, dateFormat, parsed, runtime), parsed.caseStyle)
      }
      case 'field': {
        const parsed = parseFieldToken(bodyOf(span))
        if (!parsed.fieldName) return span.raw
        const key = `FIELD:${parsed.fieldName}`
        const known = readVariable(runtime.variables, key)
        if (known?.value !== null && known?.value !== undefined)
          return renderAnswer(known.value, { ...fieldRenderShape, multiFormat: parsed.multiFormat, multiSelect: parsed.multiSelect })
        const values = await runtime.fieldValues(parsed)
        const answer = await answerFor(runtime, {
          kind: 'suggester',
          key,
          label: parsed.label ?? parsed.fieldName,
          defaultValue: parsed.defaultValue || values[0] || '',
          options: values,
          displayOptions: null,
          allowCustom: true,
          multiSelect: parsed.multiSelect,
          multiFormat: parsed.multiFormat,
          optional: false,
          trim: false,
          caseStyle: null,
          numeric: {},
          dateFormat: null,
          withTime: false,
        })
        return renderAnswer(answer ?? parsed.defaultValue, {
          ...fieldRenderShape, multiFormat: parsed.multiFormat, multiSelect: parsed.multiSelect,
        })
      }
      case 'file': {
        const parsed = parseFileToken(bodyOf(span))
        if (!parsed.folder) return span.raw
        const key = parsed.aliasName ?? parsed.folder
        const known = readVariable(runtime.variables, key)
        if (known?.value !== null && known?.value !== undefined)
          return renderFileAnswer(known.value, parsed)
        if (parsed.optional) {
          const answer = await answerFor(runtime, {
            kind: 'suggester',
            key,
            label: parsed.label ?? parsed.folder,
            defaultValue: '',
            options: [],
            displayOptions: null,
            allowCustom: parsed.allowCustomInput,
            multiSelect: parsed.multiSelect,
            multiFormat: 'auto',
            optional: true,
            trim: false,
            caseStyle: null,
            numeric: {},
            dateFormat: null,
            withTime: false,
          })
          if (answer === null) return ''
          return renderFileAnswer(answer, parsed)
        }
        return renderFileAnswer(await runtime.pickFile(parsed), parsed)
      }
      case 'mvalue': {
        const known = readVariable(runtime.variables, 'mvalue')
        const expression = typeof known?.value === 'string' && known.value.trim()
          ? known.value
          : await runtime.prompt({
            kind: 'math',
            key: 'mvalue',
            label: 'Math expression',
            defaultValue: '',
            options: [],
            displayOptions: null,
            allowCustom: false,
            multiSelect: false,
            multiFormat: 'auto',
            optional: false,
            trim: false,
            caseStyle: null,
            numeric: {},
            dateFormat: null,
            withTime: false,
          })
        if (typeof expression !== 'string' || !expression.trim()) return ''
        const result = evaluateMathExpression(expression)
        if (result.error || result.value === null) {
          runtime.warn(result.error ?? 'the expression has no answer')
          return ''
        }
        return formatMathValue(result.value)
      }
      case 'random': {
        const length = randomLengthOf(bodyOf(span))
        if (length === null) {
          runtime.warn('{{RANDOM:}} wants a whole number from 1 to 100')
          return ''
        }
        return randomString(length)
      }
      case 'property':
        return renderAnswer(options.propertyValue ?? '', propertyRenderShape)
      default:
        return null
    }
  })

  text = mapTokensSync(text, (span) => {
    switch (span.name) {
      case 'title':
        return runtime.title ?? ''
      case 'linkcurrent':
        return runtime.linkToActive(null) ?? ''
      case 'linksection':
        return runtime.linkToActive(runtime.cursorHeadingPath()) ?? ''
      case 'filenamecurrent':
        return runtime.activeTitle ?? ''
      case 'folder':
        return runtime.folderPath ?? ''
      case 'foldercurrent':
        return runtime.activeFolderPath ?? ''
      default:
        return null
    }
  })

  // The caret marker is taken from the finished text, so an included template or a macro that
  // emits one lands where the author put it rather than at its offset in the raw format.
  let cursor: number | null = null
  if (!options.preserveCursor) {
    const span = scanTokens(text).find((candidate) => candidate.name === 'cursor')
    if (span) {
      cursor = span.start
      text = `${text.slice(0, span.start)}${text.slice(span.end)}`
    }
  }
  return { text, cursor }
}

const fieldRenderShape: PromptRequest = {
  kind: 'suggester', key: '', label: '', defaultValue: '', options: [], displayOptions: null,
  allowCustom: false, multiSelect: false, multiFormat: 'auto', optional: false, trim: false,
  caseStyle: null, numeric: {}, dateFormat: null, withTime: false,
}

const propertyRenderShape: PromptRequest = { ...fieldRenderShape }

function renderFileAnswer(value: PromptAnswer, token: ParsedFileToken): string {
  const items = Array.isArray(value) ? value : value === null ? [] : [value]
  return items.map((item) => {
    if (token.mode === 'path') return item
    const title = item.split('/').pop() ?? item
    return token.mode === 'link' ? `[[${title}]]` : title
  }).join(', ')
}

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/

/**
 * A `{{VDATE:}}` answer is stored as the text the author gave and rendered through the token's own
 * format, so an ISO date is reformatted while anything the parser cannot read is copied through —
 * the reference's back-compat branch, which keeps a script-set value working.
 */
function renderStoredDate(stored: string, format: string, parsed: { snap: { boundary: 'start' | 'end'; unit: string } | null }, runtime: FormatRuntime): string {
  const iso = ISO_DATE_RE.exec(stored.trim())
  if (!iso) return stored
  const date = new Date(
    Number(iso[1]),
    Number(iso[2]) - 1,
    Number(iso[3]),
    Number(iso[4] ?? 0),
    Number(iso[5] ?? 0),
    Number(iso[6] ?? 0),
  )
  const snapped = parsed.snap ? snapDate(date, parsed.snap, runtime.locale) : date
  return formatDatePattern(snapped, format, { locale: runtime.locale })
}

async function includeTemplates(text: string, runtime: FormatRuntime): Promise<string> {
  const visited = new Set<string>()
  let output = text
  for (let depth = 0; depth < 10; depth += 1) {
    const span = scanTokens(output).find((candidate) => candidate.name === 'template')
    if (!span) break
    const name = namedReference(bodyOf(span)).name
    if (!name) {
      output = `${output.slice(0, span.start)}${output.slice(span.end)}`
      continue
    }
    if (visited.has(name)) {
      runtime.warn(`template "${name}" includes itself`)
      output = `${output.slice(0, span.start)}[skipped: ${name}]${output.slice(span.end)}`
      continue
    }
    visited.add(name)
    const body = await runtime.templateBody(name)
    output = `${output.slice(0, span.start)}${body ?? ''}${output.slice(span.end)}`
  }
  return output
}

/** The token list a settings surface can render as a cheat sheet or an autocomplete source. */
export const FORMAT_TOKEN_HELP: readonly { token: string; description: string }[] = [
  { token: '{{VALUE}}', description: 'Ask once and reuse the answer everywhere' },
  { token: '{{VALUE:label}}', description: 'Ask for a named value' },
  { token: '{{VALUE:a,b,c}}', description: 'Pick from a list' },
  { token: '{{VALUE:x|type:multiline}}', description: 'text, multiline, number, slider, checkbox, date' },
  { token: '{{VALUE:x|default:y|optional|trim}}', description: 'Prefill, allow an empty answer, strip spaces' },
  { token: '{{VALUE:x|case:title}}', description: 'kebab, snake, camel, pascal, title, lower, upper, slug' },
  { token: '{{VALUE:a,b|multi|format:yaml}}', description: 'Pick several and write them as a list' },
  { token: '{{DATE}}', description: 'Today, in the default date format' },
  { token: '{{DATE:YYYY-MM-DD}}', description: 'Any date pattern, with [literal] escaping' },
  { token: '{{DATE+7}}', description: 'Shift the day the token measures from' },
  { token: '{{DATE|startof:week}}', description: 'Snap to a period boundary: year, quarter, month, week, isoweek, day' },
  { token: '{{DATE|case:upper}}', description: 'Change the rendered case' },
  { token: '{{TIME:HH:mm}}', description: 'The clock time' },
  { token: '{{VDATE:due, YYYY-MM-DD|optional}}', description: 'Ask for one date, reuse it, reformat it per use' },
  { token: '{{TITLE}}', description: 'The note this run is about' },
  { token: '{{LINKCURRENT}}', description: 'A link to the note that was open' },
  { token: '{{LINKSECTION}}', description: 'A link to the heading the caret is under' },
  { token: '{{FILENAMECURRENT}}', description: 'The title of the note that was open' },
  { token: '{{FOLDER}}', description: 'Where this run writes' },
  { token: '{{FOLDERCURRENT}}', description: 'Where the open note lives' },
  { token: '{{SELECTED}}', description: 'The editor selection' },
  { token: '{{CLIPBOARD}}', description: 'The clipboard text' },
  { token: '{{RANDOM:8}}', description: 'Random letters and digits, 1 to 100 long' },
  { token: '{{MVALUE}}', description: 'Ask for an arithmetic expression and write its answer' },
  { token: '{{FIELD:status|folder:Work}}', description: 'Pick a value other notes already use' },
  { token: '{{FILE:Journal|link}}', description: 'Pick a note: name, path or link' },
  { token: '{{TEMPLATE:Daily}}', description: 'Splice another template in' },
  { token: '{{MACRO:Cleanup}}', description: 'Run a macro and write its text' },
  { token: '{{GLOBAL_VAR:name}}', description: 'Insert a global snippet' },
  { token: '{{DAILY}}', description: 'The periodic note for today: DAILY, WEEKLY, MONTHLY, QUARTERLY, YEARLY, with |link and +N' },
  { token: '{{PROPERTY}}', description: 'The property value a property capture is editing' },
  { token: '{{cursor}}', description: 'Where the caret lands' },
]
