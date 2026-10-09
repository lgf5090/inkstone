/**
 * The data model for QuickAdd-style choices: a named automation the user runs from the launcher,
 * the command palette or a hotkey. Three executable kinds (template, capture, macro) plus groups
 * that only hold other choices, and the account-level options that steer every run.
 *
 * Every function here is total: a hand-edited file or a stale account record is dropped entry by
 * entry with a count, never thrown at, because the worker validates the same shape on PUT.
 */
import { organizerColorOrNull, normalizeOrganizerIcon } from './organizer-colors'

export const QUICKADD_APP = 'inkstone'
export const QUICKADD_KIND = 'quickadd'
export const QUICKADD_VERSION = 1

export const QUICKADD_LIMITS = {
  maxChoices: 400,
  maxDepth: 5,
  maxNameLength: 120,
  maxTextLength: 240,
  maxFormatLength: 20_000,
  maxPathLength: 400,
  maxSteps: 60,
  maxScriptLength: 60_000,
  maxGlobalVars: 100,
  maxRecent: 12,
  maxIdLength: 64,
  maxEachLineEntries: 500,
  maxPayloadLength: 4 * 1024 * 1024,
} as const

export type QuickAddChoiceType = 'template' | 'capture' | 'macro' | 'group'
export type QuickAddDateOrigin = 'run' | 'note' | 'ask'
export type QuickAddTemplateMode = 'new-note' | 'insert-here'
/** Use the template named on the choice, or pick one from the library every run. */
export type QuickAddTemplatePick = 'fixed' | 'ask'
export type QuickAddFolderMode = 'default' | 'fixed' | 'ask' | 'source'
export type QuickAddExistingAction = 'ask' | 'number' | 'overwrite' | 'cancel'
export type QuickAddCaptureTargetMode = 'active' | 'note'
export type QuickAddPosition = 'bottom' | 'top' | 'insertAfter' | 'insertBefore' | 'cursor' | 'lineAbove' | 'lineBelow'
export type QuickAddCreateAt = 'top' | 'bottom' | 'cursor' | 'ordered'
export type QuickAddBlankLineMode = 'auto' | 'skip' | 'none'
export type QuickAddOrderKey = 'lexical' | 'date' | 'numeric' | 'semver' | 'insertion'
export type QuickAddDirection = 'asc' | 'desc'
/** Where a heading the ordering key cannot be read from belongs: the reference parks them at the
 * bottom, but a changelog that opens with an `Unreleased` band wants them at the top instead. */
export type QuickAddUnparseablePolicy = 'top' | 'bottom'
export type QuickAddOnePageMode = 'always' | 'auto' | 'never'

export type QuickAddStartupScope = 'session' | 'day'
/** Which pane the finished note goes to: the one the reader is in, or the one beside it. */
export type QuickAddOpenPane = 'active' | 'other'
/** How the app renders it there: leave the reader's own choice, or ask for a specific mode. */
export type QuickAddOpenLayout = 'inherit' | 'live' | 'split' | 'preview'
export type QuickAddPeriod = 'daily' | 'weekly' | 'monthly' | 'quarterly' | 'yearly'
export type QuickAddConditionOperator = 'eq' | 'ne' | 'has' | 'empty' | 'gt' | 'lt'

export interface QuickAddChoiceBase {
  id: string
  name: string
  parentId: string | null
  position: number
  icon: string | null
  color: string | null
  enabled: boolean
  asCommand: boolean
  hotkey: string | null
  dateOrigin: QuickAddDateOrigin
  /** Ask everything on one page, one at a time, or follow the account setting when absent. */
  onePage?: QuickAddOnePageMode
  /** Offer a copy of the created note's link on the clipboard once the run is done. */
  copyText?: string
}

export interface QuickAddTemplateChoice extends QuickAddChoiceBase {
  type: 'template'
  templateId: string | null
  templatePick: QuickAddTemplatePick
  /** When the pick asks, only templates in this library category are offered. */
  templatePickCategory: string | null
  mode: QuickAddTemplateMode
  folderMode: QuickAddFolderMode
  folderPath: string
  nameFormat: { enabled: boolean; format: string }
  existing: QuickAddExistingAction
  openAfter: boolean
  /** Absent means the app decides, which is what every record written before these fields means. */
  openPane?: QuickAddOpenPane
  openLayout?: QuickAddOpenLayout
  openFocus?: boolean
  linkToSource: boolean
  copyLink: boolean
  tags: string[]
}

export interface QuickAddCaptureChoice extends QuickAddChoiceBase {
  type: 'capture'
  targetMode: QuickAddCaptureTargetMode
  targetTitle: string
  createIfMissing: boolean
  createTemplateId: string | null
  writePosition: QuickAddPosition
  after: string
  before: string
  atSectionEnd: boolean
  considerSubsections: boolean
  createLineIfMissing: boolean
  createAt: QuickAddCreateAt
  inline: boolean
  replaceExisting: boolean
  /** Ask which heading to insert under, from the target note's own headings, at run time. */
  promptHeading: boolean
  blankLine: QuickAddBlankLineMode
  orderBy: { by: QuickAddOrderKey; direction: QuickAddDirection; dateFormat: string; unparseable: QuickAddUnparseablePolicy }
  format: { enabled: boolean; format: string }
  task: boolean
  eachLine: boolean
  useSelectionAsValue: boolean | null
  openAfter: boolean
  openPane?: QuickAddOpenPane
  openLayout?: QuickAddOpenLayout
  openFocus?: boolean
  linkToSource: boolean
  copyLink: boolean
  property: {
    enabled: boolean
    prompted: boolean
    name: string
    action: 'set' | 'append'
    createIfMissing: boolean
    format: { enabled: boolean; format: string }
  }
}

export type QuickAddStep =
  | { kind: 'choice'; choiceId: string }
  | { kind: 'ask'; variable: string; label: string; options: string }
  | { kind: 'set'; variable: string; value: string }
  | { kind: 'insert'; text: string }
  | { kind: 'create'; title: string; templateId: string | null; folderPath: string; openAfter: boolean }
  | { kind: 'capture'; title: string; text: string; position: 'bottom' | 'top' }
  | { kind: 'copy'; text: string }
  | { kind: 'command'; commandId: string }
  | { kind: 'open'; title: string }
  | { kind: 'notify'; text: string }
  | { kind: 'wait'; ms: number }
  | { kind: 'script'; name: string; code: string }
  | { kind: 'if'; variable: string; operator: QuickAddConditionOperator; value: string; then: QuickAddStep[]; else: QuickAddStep[] }

export interface QuickAddMacroChoice extends QuickAddChoiceBase {
  type: 'macro'
  steps: QuickAddStep[]
  /** Fire this macro when the notebook finishes loading, without anyone asking. */
  runOnStartup: boolean
}

export interface QuickAddGroupChoice extends QuickAddChoiceBase {
  type: 'group'
  collapsed: boolean
}

export type QuickAddChoice =
  | QuickAddTemplateChoice
  | QuickAddCaptureChoice
  | QuickAddMacroChoice
  | QuickAddGroupChoice

export interface QuickAddPeriodicSettings {
  folder: string
  format: string
  templateId: string | null
}

export interface QuickAddGlobalVar {
  name: string
  value: string
}

export interface QuickAddRecentRun {
  id: string
  at: number
}

export interface QuickAddSettings {
  enabled: boolean
  notifications: boolean
  /** Say that a run stopped because the reader closed the question, rather than saying nothing. */
  cancelNotice: boolean
  selectionAsValue: boolean
  /** The launcher's filter also looks inside groups and lists what it finds with its path. */
  searchNestedChoices: boolean
  onePage: QuickAddOnePageMode
  drafts: boolean
  /** How often a macro flagged "run on startup" may fire: once per load, or once per day. */
  startupScope: QuickAddStartupScope
  defaultFolder: string
  dateFormat: string
  timeFormat: string
  globalVars: QuickAddGlobalVar[]
  periodic: Record<QuickAddPeriod, QuickAddPeriodicSettings>
  recent: QuickAddRecentRun[]
}

export interface QuickAddLibrary {
  version: number
  settings: QuickAddSettings
  choices: QuickAddChoice[]
}

/** The one shape used by the account record, a downloaded file and an upload, so all three parse alike. */
export interface QuickAddPayload extends QuickAddLibrary {
  app: typeof QUICKADD_APP
  kind: typeof QUICKADD_KIND
  exportedAt: number
}

export interface QuickAddParseResult {
  data: QuickAddLibrary | null
  dropped: number
  truncated: boolean
}

const PERIODS: readonly QuickAddPeriod[] = ['daily', 'weekly', 'monthly', 'quarterly', 'yearly']
const DEFAULT_PERIODIC: Record<QuickAddPeriod, QuickAddPeriodicSettings> = {
  daily: { folder: 'Daily', format: 'YYYY-MM-DD', templateId: null },
  weekly: { folder: 'Weekly', format: 'YYYY-[W]ww', templateId: null },
  monthly: { folder: 'Monthly', format: 'YYYY-MM', templateId: null },
  quarterly: { folder: 'Quarterly', format: 'YYYY-[Q]q', templateId: null },
  yearly: { folder: 'Yearly', format: 'YYYY', templateId: null },
}

export const QUICKADD_PERIODS = PERIODS
export const QUICKADD_CONDITION_OPERATORS: readonly QuickAddConditionOperator[] = [
  'eq', 'ne', 'has', 'empty', 'gt', 'lt',
]

export function defaultQuickAddSettings(): QuickAddSettings {
  return {
    enabled: true,
    notifications: true,
    cancelNotice: false,
    selectionAsValue: true,
    searchNestedChoices: true,
    onePage: 'auto',
    drafts: true,
    startupScope: 'day',
    defaultFolder: '',
    dateFormat: 'YYYY-MM-DD',
    timeFormat: 'HH:mm',
    globalVars: [],
    periodic: Object.fromEntries(
      PERIODS.map((period) => [period, { ...DEFAULT_PERIODIC[period] }]),
    ) as Record<QuickAddPeriod, QuickAddPeriodicSettings>,
    recent: [],
  }
}

function baseChoice(over: Partial<QuickAddChoiceBase>): QuickAddChoiceBase {
  return {
    id: over.id ?? '',
    name: over.name ?? '',
    parentId: over.parentId ?? null,
    position: over.position ?? 0,
    icon: over.icon ?? null,
    color: over.color ?? null,
    enabled: over.enabled ?? true,
    asCommand: over.asCommand ?? false,
    hotkey: over.hotkey ?? null,
    dateOrigin: over.dateOrigin ?? 'run',
    onePage: over.onePage,
    copyText: over.copyText,
  }
}

export function newTemplateChoice(id: string, name: string, position: number): QuickAddTemplateChoice {
  return {
    ...baseChoice({ id, name, position }),
    type: 'template',
    templateId: null,
    templatePick: 'fixed',
    templatePickCategory: null,
    mode: 'new-note',
    folderMode: 'default',
    folderPath: '',
    nameFormat: { enabled: false, format: '{{DATE:YYYY-MM-DD}}' },
    existing: 'ask',
    openAfter: true,
    linkToSource: false,
    copyLink: false,
    tags: [],
  }
}

export function newCaptureChoice(id: string, name: string, position: number): QuickAddCaptureChoice {
  return {
    ...baseChoice({ id, name, position }),
    type: 'capture',
    targetMode: 'note',
    targetTitle: 'Inbox',
    createIfMissing: true,
    createTemplateId: null,
    writePosition: 'bottom',
    after: '',
    before: '',
    atSectionEnd: false,
    considerSubsections: false,
    createLineIfMissing: true,
    createAt: 'bottom',
    inline: false,
    replaceExisting: false,
    promptHeading: false,
    blankLine: 'auto',
    orderBy: { by: 'lexical', direction: 'desc', dateFormat: 'YYYY-MM-DD', unparseable: 'bottom' },
    format: { enabled: false, format: '{{VALUE}}' },
    task: false,
    eachLine: false,
    useSelectionAsValue: null,
    openAfter: false,
    linkToSource: false,
    copyLink: false,
    property: {
      enabled: false,
      prompted: false,
      name: '',
      action: 'set',
      createIfMissing: true,
      format: { enabled: false, format: '{{VALUE}}' },
    },
  }
}

export function newMacroChoice(id: string, name: string, position: number): QuickAddMacroChoice {
  return { ...baseChoice({ id, name, position }), type: 'macro', steps: [], runOnStartup: false }
}

export function newGroupChoice(id: string, name: string, position: number): QuickAddGroupChoice {
  return { ...baseChoice({ id, name, position }), type: 'group', collapsed: false }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function textOf(value: unknown, maxLength: number, fallback = ''): string {
  if (typeof value !== 'string') return fallback
  return value.length > maxLength ? value.slice(0, maxLength) : value
}

function boolOf(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function countOf(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(Math.max(Math.trunc(value), min), max)
}

function pick<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? value as T : fallback
}

/**
 * A folder path is matched against folder names, so separators are normalised here rather than at
 * every call site. Trimming is not enough: `../` and `.` segments would otherwise name a folder the
 * user cannot see in the tree, and an embedded NUL would break the stored record.
 */
export function normalizeFolderPath(value: unknown): string {
  if (typeof value !== 'string') return ''
  const segments = value.split(/[\\/]/).map((part) => part.replace(/\0/g, '').trim())
  const kept: string[] = []
  for (const segment of segments) {
    if (!segment || segment === '.' || segment === '..') continue
    kept.push(segment)
    if (kept.length > 24) break
  }
  return kept.join('/').slice(0, QUICKADD_LIMITS.maxPathLength)
}

function oneLine(value: unknown, maxLength: number): string {
  return textOf(value, maxLength).replace(/[\r\n]+/g, ' ').trim()
}

function normalizeTags(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const tags: string[] = []
  for (const raw of value.slice(0, 8)) {
    const tag = oneLine(raw, 30)
    if (!tag || seen.has(tag.toLowerCase())) continue
    seen.add(tag.toLowerCase())
    tags.push(tag)
  }
  return tags
}

const HOTKEY_RE = /^[\w+ -]{1,40}$/
const CHOICE_ID_RE = /^[0-9a-z_-]{1,64}$/
const VARIABLE_NAME_RE = /^[\w\u00a1-\uffff][\w \u00a1-\uffff-]{0,59}$/

/**
 * Names that would reach a prototype when a caller keys a plain object by the variable's name.
 * A global variable is user text, and a token's answer is text too, so the guard lives with the
 * name rather than at each place a name is used.
 */
const RESERVED_VARIABLE_NAMES = new Set(['__proto__', 'constructor', 'prototype', 'globalthis'])

function normalizeHotkey(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const combo = value.trim().toLowerCase()
  if (!combo || !HOTKEY_RE.test(combo) || !/[a-z0-9]$/.test(combo)) return null
  if (!/(^|\+)(cmd|ctrl|alt|shift|meta)\+/.test(combo)) return null
  return combo.slice(0, 40)
}

function normalizeRef(value: unknown): string | null {
  return typeof value === 'string' && CHOICE_ID_RE.test(value) ? value : null
}

function normalizeVariableName(value: unknown): string {
  const name = oneLine(value, 60)
  if (!VARIABLE_NAME_RE.test(name)) return ''
  return RESERVED_VARIABLE_NAMES.has(name.toLowerCase()) ? '' : name
}

function normalizeStep(value: unknown, depth: number): QuickAddStep | null {
  if (!isRecord(value) || depth > 2) return null
  switch (value.kind) {
    case 'choice':
      return { kind: 'choice', choiceId: normalizeRef(value.choiceId) ?? '' }
    case 'ask':
      return {
        kind: 'ask',
        variable: normalizeVariableName(value.variable),
        label: textOf(value.label, QUICKADD_LIMITS.maxTextLength),
        options: textOf(value.options, 4000),
      }
    case 'set':
      return {
        kind: 'set',
        variable: normalizeVariableName(value.variable),
        value: textOf(value.value, QUICKADD_LIMITS.maxFormatLength),
      }
    case 'insert':
      return { kind: 'insert', text: textOf(value.text, QUICKADD_LIMITS.maxFormatLength) }
    case 'create':
      return {
        kind: 'create',
        title: oneLine(value.title, QUICKADD_LIMITS.maxNameLength),
        templateId: normalizeRef(value.templateId),
        folderPath: normalizeFolderPath(value.folderPath),
        openAfter: boolOf(value.openAfter, true),
      }
    case 'capture':
      return {
        kind: 'capture',
        title: oneLine(value.title, QUICKADD_LIMITS.maxNameLength),
        text: textOf(value.text, QUICKADD_LIMITS.maxFormatLength),
        position: pick(value.position, ['bottom', 'top'] as const, 'bottom'),
      }
    case 'copy':
      return { kind: 'copy', text: textOf(value.text, QUICKADD_LIMITS.maxFormatLength) }
    case 'open':
      return { kind: 'open', title: oneLine(value.title, QUICKADD_LIMITS.maxNameLength) }
    case 'command':
      return { kind: 'command', commandId: oneLine(value.commandId, 60) }
    case 'notify':
      return { kind: 'notify', text: oneLine(value.text, QUICKADD_LIMITS.maxTextLength) }
    case 'wait':
      return { kind: 'wait', ms: countOf(value.ms, 0, 30_000, 250) }
    case 'script':
      return {
        kind: 'script',
        name: oneLine(value.name, QUICKADD_LIMITS.maxTextLength),
        code: textOf(value.code, QUICKADD_LIMITS.maxScriptLength),
      }
    case 'if':
      return {
        kind: 'if',
        variable: normalizeVariableName(value.variable),
        operator: pick(value.operator, QUICKADD_CONDITION_OPERATORS, 'eq'),
        value: textOf(value.value, QUICKADD_LIMITS.maxTextLength),
        then: normalizeSteps(value.then, depth + 1),
        else: normalizeSteps(value.else, depth + 1),
      }
    default:
      return null
  }
}

function normalizeSteps(value: unknown, depth: number): QuickAddStep[] {
  if (!Array.isArray(value)) return []
  const steps: QuickAddStep[] = []
  for (const candidate of value) {
    const step = normalizeStep(candidate, depth)
    if (step) steps.push(step)
    if (steps.length >= QUICKADD_LIMITS.maxSteps) break
  }
  return steps
}

export function normalizeQuickAddChoice(value: unknown): QuickAddChoice | null {
  if (!isRecord(value)) return null
  const id = normalizeRef(value.id)
  if (!id) return null
  const base = baseChoice({
    id,
    name: oneLine(value.name, QUICKADD_LIMITS.maxNameLength),
    parentId: normalizeRef(value.parentId),
    position: countOf(value.position, 0, 1_000_000, 0),
    icon: normalizeOrganizerIcon(typeof value.icon === 'string' ? value.icon : null),
    color: organizerColorOrNull(value.color),
    enabled: boolOf(value.enabled, true),
    asCommand: boolOf(value.asCommand, false),
    hotkey: normalizeHotkey(value.hotkey),
    dateOrigin: pick(value.dateOrigin, ['run', 'note', 'ask'] as const, 'run'),
    onePage: value.onePage === undefined || value.onePage === null
      ? undefined
      : pick(value.onePage, ['always', 'auto', 'never'] as const, 'auto'),
    copyText: value.copyText === undefined ? undefined : textOf(value.copyText, QUICKADD_LIMITS.maxTextLength),
  })
  if (!base.name) return null

  switch (value.type) {
    case 'template': {
      const nameFormat = isRecord(value.nameFormat) ? value.nameFormat : {}
      return {
        ...base,
        type: 'template',
        templateId: normalizeRef(value.templateId),
        templatePick: pick(value.templatePick, ['fixed', 'ask'] as const, 'fixed'),
        templatePickCategory: normalizeRef(value.templatePickCategory),
        mode: pick(value.mode, ['new-note', 'insert-here'] as const, 'new-note'),
        folderMode: pick(value.folderMode, ['default', 'fixed', 'ask', 'source'] as const, 'default'),
        folderPath: normalizeFolderPath(value.folderPath),
        nameFormat: {
          enabled: boolOf(nameFormat.enabled, false),
          format: oneLine(nameFormat.format, QUICKADD_LIMITS.maxNameLength),
        },
        existing: pick(value.existing, ['ask', 'number', 'overwrite', 'cancel'] as const, 'ask'),
        openAfter: boolOf(value.openAfter, true),
        ...normalizeOpening(value),
        linkToSource: boolOf(value.linkToSource, false),
        copyLink: boolOf(value.copyLink, false),
        tags: normalizeTags(value.tags),
      }
    }
    case 'capture': {
      const format = isRecord(value.format) ? value.format : {}
      const property = isRecord(value.property) ? value.property : {}
      const propertyFormat = isRecord(property.format) ? property.format : {}
      const orderBy = isRecord(value.orderBy) ? value.orderBy : {}
      return {
        ...base,
        type: 'capture',
        targetMode: pick(value.targetMode, ['active', 'note'] as const, 'note'),
        targetTitle: oneLine(value.targetTitle, QUICKADD_LIMITS.maxNameLength),
        createIfMissing: boolOf(value.createIfMissing, true),
        createTemplateId: normalizeRef(value.createTemplateId),
        writePosition: pick(value.writePosition, ['bottom', 'top', 'insertAfter', 'insertBefore', 'cursor', 'lineAbove', 'lineBelow'] as const, 'bottom'),
        after: oneLine(value.after, QUICKADD_LIMITS.maxTextLength),
        before: oneLine(value.before, QUICKADD_LIMITS.maxTextLength),
        atSectionEnd: boolOf(value.atSectionEnd, false),
        considerSubsections: boolOf(value.considerSubsections, false),
        createLineIfMissing: boolOf(value.createLineIfMissing, true),
        createAt: pick(value.createAt, ['top', 'bottom', 'cursor', 'ordered'] as const, 'bottom'),
        inline: boolOf(value.inline, false),
        replaceExisting: boolOf(value.replaceExisting, false),
        promptHeading: boolOf(value.promptHeading, false),
        blankLine: pick(value.blankLine, ['auto', 'skip', 'none'] as const, 'auto'),
        orderBy: {
          by: pick(orderBy.by, ['lexical', 'date', 'numeric', 'semver', 'insertion'] as const, 'lexical'),
          direction: pick(orderBy.direction, ['asc', 'desc'] as const, 'desc'),
          dateFormat: oneLine(orderBy.dateFormat, 40) || 'YYYY-MM-DD',
          unparseable: pick(orderBy.unparseable, ['top', 'bottom'] as const, 'bottom'),
        },
        format: {
          enabled: boolOf(format.enabled, false),
          format: textOf(format.format, QUICKADD_LIMITS.maxFormatLength, '{{VALUE}}'),
        },
        task: boolOf(value.task, false),
        eachLine: boolOf(value.eachLine, false),
        useSelectionAsValue: typeof value.useSelectionAsValue === 'boolean' ? value.useSelectionAsValue : null,
        openAfter: boolOf(value.openAfter, false),
        ...normalizeOpening(value),
        linkToSource: boolOf(value.linkToSource, false),
        copyLink: boolOf(value.copyLink, false),
        property: {
          enabled: boolOf(property.enabled, false),
          prompted: boolOf(property.prompted, false),
          name: oneLine(property.name, QUICKADD_LIMITS.maxTextLength),
          action: pick(property.action, ['set', 'append'] as const, 'set'),
          createIfMissing: boolOf(property.createIfMissing, true),
          format: {
            enabled: boolOf(propertyFormat.enabled, false),
            format: textOf(propertyFormat.format, QUICKADD_LIMITS.maxFormatLength, '{{VALUE}}'),
          },
        },
      }
    }
    case 'macro':
      return { ...base, type: 'macro', steps: normalizeSteps(value.steps, 0), runOnStartup: boolOf(value.runOnStartup, false) }
    case 'group':
      return { ...base, type: 'group', collapsed: boolOf(value.collapsed, false) }
    default:
      return null
  }
}

/**
 * The three opening fields are each optional and an unknown value is dropped rather than defaulted: a
 * record saying `openPane: 'drawer'` should keep behaving like the app's own default instead of being
 * quietly rewritten to a pane nobody chose.
 */
function normalizeOpening(value: Record<string, unknown>): {
  openPane?: QuickAddOpenPane
  openLayout?: QuickAddOpenLayout
  openFocus?: boolean
} {
  const out: { openPane?: QuickAddOpenPane; openLayout?: QuickAddOpenLayout; openFocus?: boolean } = {}
  if (value.openPane === 'active' || value.openPane === 'other') out.openPane = value.openPane
  if (value.openLayout === 'inherit' || value.openLayout === 'live'
    || value.openLayout === 'split' || value.openLayout === 'preview') out.openLayout = value.openLayout
  if (typeof value.openFocus === 'boolean') out.openFocus = value.openFocus
  return out
}

function normalizeGlobalVars(value: unknown): QuickAddGlobalVar[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const vars: QuickAddGlobalVar[] = []
  for (const candidate of value) {
    if (!isRecord(candidate)) continue
    const name = normalizeVariableName(candidate.name)
    if (!name || seen.has(name.toLowerCase())) continue
    seen.add(name.toLowerCase())
    vars.push({ name, value: textOf(candidate.value, QUICKADD_LIMITS.maxFormatLength) })
    if (vars.length >= QUICKADD_LIMITS.maxGlobalVars) break
  }
  return vars
}

function normalizeRecent(value: unknown, knownIds: ReadonlySet<string>): QuickAddRecentRun[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const recent: QuickAddRecentRun[] = []
  for (const candidate of value) {
    if (!isRecord(candidate)) continue
    const id = normalizeRef(candidate.id)
    if (!id || seen.has(id) || !knownIds.has(id)) continue
    seen.add(id)
    const at = typeof candidate.at === 'number' && Number.isFinite(candidate.at) ? Math.trunc(candidate.at) : 0
    recent.push({ id, at: Math.min(Math.max(at, 0), Date.UTC(2100, 0, 1)) })
    if (recent.length >= QUICKADD_LIMITS.maxRecent) break
  }
  return recent
}

/**
 * Choices are stored flat and assembled into a tree by `parentId`, so a hostile or hand-edited
 * record can point a child at a missing parent, at itself, or into a cycle. All three are fixed
 * here rather than at read time: an orphan becomes a root, and `depthFrom` reports a cycle as
 * infinitely deep, which detaches the entry that closes it. A parent that is not a group is a lie
 * of the same kind.
 */
function repairTree(choices: QuickAddChoice[]): QuickAddChoice[] {
  const byId = new Map(choices.map((choice) => [choice.id, choice]))
  const depthFrom = (choice: QuickAddChoice): number => {
    let depth = 0
    const walked = new Set<string>([choice.id])
    let parent = choice.parentId ? byId.get(choice.parentId) : null
    while (parent) {
      if (walked.has(parent.id)) return Number.POSITIVE_INFINITY
      walked.add(parent.id)
      depth += 1
      parent = parent.parentId ? byId.get(parent.parentId) : null
    }
    return depth
  }
  for (const choice of choices) {
    if (!choice.parentId) continue
    const parent = byId.get(choice.parentId)
    if (!parent || parent.type !== 'group' || depthFrom(choice) >= QUICKADD_LIMITS.maxDepth)
      choice.parentId = null
  }
  return choices
}

function resequence(choices: QuickAddChoice[]): QuickAddChoice[] {
  const sorted = [...choices].sort((a, b) => a.position - b.position || a.name.localeCompare(b.name))
  const nextPosition = new Map<string, number>()
  for (const choice of sorted) {
    const key = choice.parentId ?? ''
    const next = nextPosition.get(key) ?? 0
    choice.position = next
    nextPosition.set(key, next + 1)
  }
  return flattenChoices(sorted)
}

/**
 * A macro step that runs another choice is the one reference the record owns, so a dangling one is
 * dropped: running a deleted choice would silently do nothing. Template ids point into the template
 * library, which is a separate record, so they survive here and are reported at run time instead.
 */
export function parseQuickAddLibrary(value: unknown): QuickAddParseResult {
  if (!isRecord(value)) return { data: null, dropped: 0, truncated: false }
  if (value.app !== QUICKADD_APP || value.kind !== QUICKADD_KIND)
    return { data: null, dropped: 0, truncated: false }
  const rawChoices = Array.isArray(value.choices) ? value.choices : []
  let dropped = 0
  let truncated = false
  if (rawChoices.length > QUICKADD_LIMITS.maxChoices) {
    truncated = true
    dropped += rawChoices.length - QUICKADD_LIMITS.maxChoices
  }
  const seen = new Set<string>()
  const choices: QuickAddChoice[] = []
  for (const candidate of rawChoices.slice(0, QUICKADD_LIMITS.maxChoices)) {
    const choice = normalizeQuickAddChoice(candidate)
    if (!choice || seen.has(choice.id)) {
      dropped += 1
      continue
    }
    seen.add(choice.id)
    choices.push(choice)
  }
  for (const choice of choices) {
    if (choice.type !== 'macro') continue
    choice.steps = choice.steps.filter((step) => step.kind !== 'choice' || !step.choiceId || seen.has(step.choiceId))
  }
  const settings = normalizeQuickAddSettings(value.settings, seen)
  return {
    data: { version: QUICKADD_VERSION, settings, choices: resequence(repairTree(choices)) },
    dropped,
    truncated,
  }
}

export function normalizeQuickAddSettings(value: unknown, knownIds: ReadonlySet<string> = new Set()): QuickAddSettings {
  const fallback = defaultQuickAddSettings()
  if (!isRecord(value)) return fallback
  const periodic = isRecord(value.periodic) ? value.periodic : {}
  return {
    enabled: boolOf(value.enabled, fallback.enabled),
    notifications: boolOf(value.notifications, fallback.notifications),
    cancelNotice: boolOf(value.cancelNotice, fallback.cancelNotice),
    selectionAsValue: boolOf(value.selectionAsValue, fallback.selectionAsValue),
    searchNestedChoices: boolOf(value.searchNestedChoices, fallback.searchNestedChoices),
    onePage: pick(value.onePage, ['always', 'auto', 'never'] as const, fallback.onePage),
    drafts: boolOf(value.drafts, fallback.drafts),
    startupScope: pick(value.startupScope, ['session', 'day'] as const, fallback.startupScope),
    defaultFolder: normalizeFolderPath(value.defaultFolder),
    dateFormat: oneLine(value.dateFormat, 40) || fallback.dateFormat,
    timeFormat: oneLine(value.timeFormat, 40) || fallback.timeFormat,
    globalVars: normalizeGlobalVars(value.globalVars),
    periodic: Object.fromEntries(PERIODS.map((period) => {
      const source = isRecord(periodic[period]) ? periodic[period] : {}
      return [period, {
        folder: normalizeFolderPath(source.folder),
        format: oneLine(source.format, 40) || DEFAULT_PERIODIC[period].format,
        templateId: normalizeRef(source.templateId),
      } satisfies QuickAddPeriodicSettings]
    })) as Record<QuickAddPeriod, QuickAddPeriodicSettings>,
    recent: normalizeRecent(value.recent, knownIds),
  }
}

/**
 * The lenient entry point: what an account record or an IndexedDB row holds is the parsed library,
 * which has lost the transport header. A bare `{choices}` is still only read as a library when it
 * really carries a choices array.
 */
export function parseQuickAddRecord(value: unknown): QuickAddParseResult {
  if (!isRecord(value)) return { data: null, dropped: 0, truncated: false }
  if (value.app === QUICKADD_APP && value.kind === QUICKADD_KIND) return parseQuickAddLibrary(value)
  if (Array.isArray(value.choices))
    return parseQuickAddLibrary({ ...value, app: QUICKADD_APP, kind: QUICKADD_KIND, version: QUICKADD_VERSION })
  return { data: null, dropped: 0, truncated: false }
}

export function parseQuickAddText(text: string): QuickAddParseResult {
  const empty: QuickAddParseResult = { data: null, dropped: 0, truncated: false }
  if (typeof text !== 'string' || text.length > QUICKADD_LIMITS.maxPayloadLength) return empty
  let value: unknown
  try {
    value = JSON.parse(text)
  }
  catch {
    return empty
  }
  return parseQuickAddLibrary(value)
}

/**
 * Read the `{ savedAt, version, library }` envelope an account stores in `users.quickadd` in the
 * shape a backup can carry. Junk, an unreadable library and an empty column all come back as null,
 * so a broken column never takes a whole export down with it.
 */
export function quickAddLibraryFromStored(raw: string | null | undefined): QuickAddLibrary | null {
  if (typeof raw !== 'string' || raw === '') return null
  let envelope: unknown
  try {
    envelope = JSON.parse(raw)
  }
  catch {
    return null
  }
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) return null
  const inner = (envelope as { library?: unknown }).library
  if (!inner || typeof inner !== 'object' || Array.isArray(inner)) return null
  return parseQuickAddRecord(inner).data
}

export function buildQuickAddPayload(
  settings: QuickAddSettings,
  choices: QuickAddChoice[],
): QuickAddPayload {
  return {
    app: QUICKADD_APP,
    kind: QUICKADD_KIND,
    version: QUICKADD_VERSION,
    exportedAt: Date.now(),
    settings: structuredClone(settings),
    choices: structuredClone(choices),
  }
}

export function childrenOf(choices: QuickAddChoice[], parentId: string | null): QuickAddChoice[] {
  return choices.filter((choice) => choice.parentId === (parentId ?? null))
}

/** Ids reachable from `id` through group children, so deleting a group can ask about its contents. */
export function descendantIds(choices: QuickAddChoice[], id: string): Set<string> {
  const found = new Set<string>()
  const stack = [id]
  while (stack.length) {
    const current = stack.pop() as string
    for (const choice of choices) {
      if (choice.parentId === current && !found.has(choice.id)) {
        found.add(choice.id)
        stack.push(choice.id)
      }
    }
  }
  return found
}

/**
 * Put a choice among a parent's children at `index`, then renumber that parent's children from 0.
 * A caller passes an index measured against the list WITHOUT the moved entry, which is what a
 * drag-and-drop or an up/down button reports. Null when the request cannot be honoured: an unknown
 * id, a parent that is not a group, or a move that would put a group inside itself.
 */
export function placeChoice(
  choices: readonly QuickAddChoice[],
  id: string,
  parentId: string | null,
  index: number,
): QuickAddChoice[] | null {
  const moving = choices.find((choice) => choice.id === id)
  if (!moving) return null
  const parent = parentId ? choices.find((choice) => choice.id === parentId) : null
  if (parentId && (!parent || parent.type !== 'group' || parentId === id)) return null
  if (parentId && descendantIds([...choices], id).has(parentId)) return null
  const siblings = choices
    .filter((choice) => (choice.parentId ?? null) === (parentId ?? null) && choice.id !== id)
    .sort((a, b) => a.position - b.position)
  const clamped = Math.max(0, Math.min(Math.trunc(index), siblings.length))
  const ordered = [...siblings.slice(0, clamped), { ...moving, parentId: parentId ?? null }, ...siblings.slice(clamped)]
  const positions = new Map(ordered.map((choice, indexAt) => [choice.id, indexAt]))
  return choices.map((choice) => {
    const position = positions.get(choice.id)
    if (position === undefined) return choice
    return { ...choice, position, parentId: choice.id === id ? (parentId ?? null) : choice.parentId }
  })
}

/** Choices in tree order: each root followed by its group's children. */
export function flattenChoices(choices: readonly QuickAddChoice[]): QuickAddChoice[] {
  const sorted = [...choices].sort((a, b) => a.position - b.position || a.name.localeCompare(b.name))
  const out: QuickAddChoice[] = []
  const visit = (parentId: string | null): void => {
    for (const choice of sorted) {
      if ((choice.parentId ?? null) !== parentId) continue
      out.push(choice)
      if (choice.type === 'group') visit(choice.id)
    }
  }
  visit(null)
  return out
}
