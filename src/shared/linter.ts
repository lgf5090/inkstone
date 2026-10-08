/**
 * The persisted half of the markdown linter: the shape a reader's rule settings travel in, the
 * budgets that keep that shape bounded, and the normalizer both the client store and the worker
 * apply before anything is trusted.
 *
 * Rule defaults live with the rules themselves (client-side, 66 of them), so this file stores only
 * what a reader actually changed. A worker therefore never needs the rule library to validate a
 * settings blob: it checks keys, kinds, and sizes, and anything it cannot recognize is dropped so a
 * typo, an old version, or a hand-edited export cannot smuggle values into a lint run.
 */

import { patternSafety } from './regex-safety'

export const LINTER_CONFIG_VERSION = 1

export const LINTER_LIMITS = {
  rulesStored: 128,
  optionsPerRule: 24,
  optionKeyChars: 80,
  optionValueChars: 500,
  listItemsPerOption: 40,
  listItemChars: 200,
  customRegexes: 40,
  regexPatternChars: 500,
  regexReplaceChars: 500,
  regexLabelChars: 100,
  foldersIgnored: 40,
  folderChars: 200,
  filesIgnored: 40,
  fileMatchChars: 300,
} as const

export const NORMAL_ARRAY_FORMATS = ['single-line', 'multi-line'] as const
export const SPECIAL_ARRAY_FORMATS = [
  'single string to single-line',
  'single string to multi-line',
  'single string comma delimited',
] as const
export const TAG_ARRAY_FORMATS = [
  'single string space delimited',
  'single-line space delimited',
] as const

export const NormalArrayFormats = {
  SingleLine: 'single-line',
  MultiLine: 'multi-line',
} as const

export const SpecialArrayFormats = {
  SingleStringToSingleLine: 'single string to single-line',
  SingleStringToMultiLine: 'single string to multi-line',
  SingleStringCommaDelimited: 'single string comma delimited',
} as const

export const TagSpecificArrayFormats = {
  SingleStringSpaceDelimited: 'single string space delimited',
  SingleLineSpaceDelimited: 'single-line space delimited',
} as const

export type NormalArrayFormat = typeof NORMAL_ARRAY_FORMATS[number]
export type SpecialArrayFormat = typeof SPECIAL_ARRAY_FORMATS[number]
export type TagArrayFormat = typeof TAG_ARRAY_FORMATS[number]
export type NormalArrayFormats = NormalArrayFormat
export type SpecialArrayFormats = SpecialArrayFormat
export type TagSpecificArrayFormats = TagArrayFormat
export type ArrayStyle = NormalArrayFormat | SpecialArrayFormat | TagArrayFormat
export type QuoteCharacter = '\'' | '"'

export const QUOTE_CHARACTERS: QuoteCharacter[] = ['"', "'"]

export interface CommonStyles {
  aliasArrayStyle: NormalArrayFormat | SpecialArrayFormat
  tagArrayStyle: TagArrayFormat | NormalArrayFormat | SpecialArrayFormat
  defaultArrayStyle: NormalArrayFormat
  minimumNumberOfDollarSignsToBeAMathBlock: number
  escapeCharacter: QuoteCharacter
  removeUnnecessaryEscapeCharsForMultiLineArrays: boolean
}

export type LinterRuleConfig = Record<string, boolean | string | number | string[]>

/** A note the reader picked as a source of extra spelling corrections, with what was parsed from it. */
export type CustomAutoCorrectContent = { filePath: string, customReplacements: Map<string, string> | null }

export type CustomReplace = {
  label: string
  find: string
  replace: string
  flags: string
  enabled: boolean
}

export type FileToIgnore = {
  label: string
  match: string
  flags: string
}

/** The waits the date-modified rule accepts for "update when the note changed". */
export const AfterFileChangeLintTimes = {
  Never: 'never',
  After5Seconds: 'after 5 seconds',
  After10Seconds: 'after 10 seconds',
  After15Seconds: 'after 15 seconds',
  After30Seconds: 'after 30 seconds',
  After1Minute: 'after 1 minute',
} as const

export type AfterFileChangeLintTimes = typeof AfterFileChangeLintTimes[keyof typeof AfterFileChangeLintTimes]

/** How long after a keystroke a note is re-linted, when the reader wants that at all. */
export const LINT_ON_IDLE_TIMES = [0, 5000, 10000, 15000, 30000, 60000] as const
export type LintOnIdleTime = typeof LINT_ON_IDLE_TIMES[number]

/** The flags a saved pattern may carry; anything else is dropped rather than compiled. */
export const ALLOWED_REGEX_FLAGS = 'dgimsuy'

export interface LinterSettings {
  /** The master switch. Off means no lint runs at all, including from the palette. */
  enabled: boolean
  lintOnSave: boolean
  lintOnPaste: boolean
  lintOnIdle: LintOnIdleTime
  /** Report which rules changed the note after a run. */
  reportChanges: boolean
  /** Keep the rule-by-rule log of the last run for the results dialog. */
  recordRunLog: boolean
  /** Console verbosity inside the engine; 'silent' keeps the run quiet but the log still records. */
  logLevel: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'silent'
  ruleConfigs: Record<string, LinterRuleConfig>
  customRegexes: CustomReplace[]
  foldersToIgnore: string[]
  filesToIgnore: FileToIgnore[]
  commonStyles: CommonStyles
}

export const DEFAULT_LINTER_SETTINGS: LinterSettings = {
  enabled: true,
  lintOnSave: false,
  lintOnPaste: true,
  lintOnIdle: 0,
  reportChanges: true,
  recordRunLog: false,
  logLevel: 'error',
  ruleConfigs: {},
  customRegexes: [],
  foldersToIgnore: [],
  filesToIgnore: [],
  commonStyles: {
    aliasArrayStyle: NormalArrayFormats.SingleLine,
    tagArrayStyle: NormalArrayFormats.SingleLine,
    defaultArrayStyle: NormalArrayFormats.SingleLine,
    minimumNumberOfDollarSignsToBeAMathBlock: 2,
    escapeCharacter: '"',
    removeUnnecessaryEscapeCharsForMultiLineArrays: false,
  },
}

const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'silent'] as const

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function text(value: unknown, max: number): string {
  return typeof value === 'string' ? value.slice(0, max) : ''
}

function boolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? value as T
    : fallback
}

function ruleConfigValue(value: unknown): boolean | string | number | string[] | null {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string') return value.slice(0, LINTER_LIMITS.optionValueChars)
  if (Array.isArray(value)) {
    return value
      .filter((item): item is string => typeof item === 'string' && item !== '')
      .slice(0, LINTER_LIMITS.listItemsPerOption)
      .map((item) => item.slice(0, LINTER_LIMITS.listItemChars))
  }

  return null
}

/**
 * A reader's stored rule configs, kept to the keys and kinds a rule could have declared.
 *
 * Values that equal the rule's default are dropped by the client before saving, so what arrives
 * here is a delta. Unknown aliases and malformed values are dropped rather than passed through: a
 * rule that no longer exists must not keep a stale toggle alive.
 */
function normalizeRuleConfigs(value: unknown): Record<string, LinterRuleConfig> {
  const source = record(value)
  const out: Record<string, LinterRuleConfig> = {}
  for (const alias of Object.keys(source).slice(0, LINTER_LIMITS.rulesStored)) {
    const config = record(source[alias])
    const clean: LinterRuleConfig = {}
    for (const key of Object.keys(config).slice(0, LINTER_LIMITS.optionsPerRule)) {
      if (!/^[a-z0-9][a-z0-9 ._/-]*$/.test(key) || key.length > LINTER_LIMITS.optionKeyChars) continue
      const cleanValue = ruleConfigValue(config[key])
      if (cleanValue !== null) clean[key] = cleanValue
    }
    if (Object.keys(clean).length) out[alias.slice(0, LINTER_LIMITS.optionKeyChars)] = clean
  }

  return out
}

function normalizeFlags(value: unknown): string {
  return [...new Set(text(value, ALLOWED_REGEX_FLAGS.length).split(''))]
    .filter((flag) => ALLOWED_REGEX_FLAGS.includes(flag))
    .join('')
}

function normalizeCustomRegexes(value: unknown): CustomReplace[] {
  if (!Array.isArray(value)) return []

  return value.slice(0, LINTER_LIMITS.customRegexes).map((item) => {
    const source = record(item)

    return {
      label: text(source.label, LINTER_LIMITS.regexLabelChars),
      find: text(source.find, LINTER_LIMITS.regexPatternChars),
      replace: text(source.replace, LINTER_LIMITS.regexReplaceChars),
      flags: normalizeFlags(source.flags),
      enabled: boolean(source.enabled, false),
    }
  })
}

function normalizeFilesToIgnore(value: unknown): FileToIgnore[] {
  if (!Array.isArray(value)) return []

  return value.slice(0, LINTER_LIMITS.filesIgnored).map((item) => {
    const source = record(item)

    return {
      label: text(source.label, LINTER_LIMITS.regexLabelChars),
      match: text(source.match, LINTER_LIMITS.fileMatchChars),
      flags: normalizeFlags(source.flags),
    }
  })
}

function normalizeStringList(value: unknown, max: number, chars: number): string[] {
  if (!Array.isArray(value)) return []

  return [...new Set(value
    .filter((item): item is string => typeof item === 'string' && item.trim() !== '')
    .map((item) => item.trim().slice(0, chars)))].slice(0, max)
}

function normalizeCommonStyles(value: unknown): CommonStyles {
  const source = record(value)
  const defaults = DEFAULT_LINTER_SETTINGS.commonStyles
  const dollarSigns = typeof source.minimumNumberOfDollarSignsToBeAMathBlock === 'number'
    ? Math.trunc(source.minimumNumberOfDollarSignsToBeAMathBlock)
    : defaults.minimumNumberOfDollarSignsToBeAMathBlock

  return {
    aliasArrayStyle: oneOf(source.aliasArrayStyle, [...NORMAL_ARRAY_FORMATS, ...SPECIAL_ARRAY_FORMATS], defaults.aliasArrayStyle),
    tagArrayStyle: oneOf(source.tagArrayStyle, [...TAG_ARRAY_FORMATS, ...NORMAL_ARRAY_FORMATS, ...SPECIAL_ARRAY_FORMATS], defaults.tagArrayStyle),
    defaultArrayStyle: oneOf(source.defaultArrayStyle, NORMAL_ARRAY_FORMATS, defaults.defaultArrayStyle),
    minimumNumberOfDollarSignsToBeAMathBlock: Math.min(3, Math.max(2, Number.isFinite(dollarSigns) ? dollarSigns : defaults.minimumNumberOfDollarSignsToBeAMathBlock)),
    escapeCharacter: oneOf(source.escapeCharacter, QUOTE_CHARACTERS, defaults.escapeCharacter),
    removeUnnecessaryEscapeCharsForMultiLineArrays: boolean(source.removeUnnecessaryEscapeCharsForMultiLineArrays, defaults.removeUnnecessaryEscapeCharsForMultiLineArrays),
  }
}

export function normalizeLinterSettings(value: unknown): LinterSettings {
  const source = record(value)
  const idle = source.lintOnIdle

  return {
    enabled: boolean(source.enabled, DEFAULT_LINTER_SETTINGS.enabled),
    lintOnSave: boolean(source.lintOnSave, DEFAULT_LINTER_SETTINGS.lintOnSave),
    lintOnPaste: boolean(source.lintOnPaste, DEFAULT_LINTER_SETTINGS.lintOnPaste),
    lintOnIdle: typeof idle === 'number' && (LINT_ON_IDLE_TIMES as readonly number[]).includes(Math.trunc(idle))
      ? Math.trunc(idle) as LintOnIdleTime
      : DEFAULT_LINTER_SETTINGS.lintOnIdle,
    reportChanges: boolean(source.reportChanges, DEFAULT_LINTER_SETTINGS.reportChanges),
    recordRunLog: boolean(source.recordRunLog, DEFAULT_LINTER_SETTINGS.recordRunLog),
    logLevel: oneOf(source.logLevel, LOG_LEVELS, DEFAULT_LINTER_SETTINGS.logLevel),
    ruleConfigs: normalizeRuleConfigs(source.ruleConfigs),
    customRegexes: normalizeCustomRegexes(source.customRegexes),
    foldersToIgnore: normalizeStringList(source.foldersToIgnore, LINTER_LIMITS.foldersIgnored, LINTER_LIMITS.folderChars),
    filesToIgnore: normalizeFilesToIgnore(source.filesToIgnore),
    commonStyles: normalizeCommonStyles(source.commonStyles),
  }
}

/** Whether a note is one the reader told the linter to leave alone. */
export function isLinterIgnoredPath(settings: LinterSettings, path: string, folderTrail: string[]): boolean {
  if (settings.foldersToIgnore.length && folderTrail.some((folder) => settings.foldersToIgnore.includes(folder))) {
    return true
  }

  return settings.filesToIgnore.some((entry) => {
    if (!entry.match) return false
    try {
      // A restored backup never passed the panel that refuses these, so the run is where it is
      // refused: an ignore test that hangs takes the whole library down with it.
      if (patternSafety(entry.match)) return false
      return new RegExp(entry.match, entry.flags || 'i').test(path)
    }
    catch {
      return false
    }
  })
}
