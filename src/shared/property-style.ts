import { DEFAULT_PROPERTY_NAMES } from './property-decorations'
import type { DecorationDefaults, NotePropertyNames } from './property-decorations'
import { formatPropertyValue } from './property-template-helpers'
import { formatDateStamp } from './property-formats'
import { dateShapeOf, isPropertyEmpty, parsePropertyValueDate, propertyValueKind, propertyValuesOf, relativeDateOf } from './property-values'
import type { DateShape, PropertyValueKind, RelativeDate } from './property-values'

export interface PropertyColorRule {
  pill?: string | null
  text?: string | null
}

export interface PropertyProgressRule {
  max?: number | null
  maxProperty?: string | null
  variant?: 'bar' | 'circle'
}

export interface PropertyFormatRule {
  template?: string | null
  markdown?: boolean
}

export interface PropertyStyleSettings {
  enabled: boolean
  colors: Record<string, Record<string, PropertyColorRule>>
  hidden: readonly string[]
  hiddenWhenEmpty: readonly string[]
  hideAllEmpty: boolean
  customDateFormats: boolean
  dateFormat: string
  dateTimeFormat: string
  relativeDateColors: boolean
  dateColors: Partial<Record<'past' | 'present' | 'future', string | null>>
  progress: Record<string, PropertyProgressRule>
  formats: Record<string, PropertyFormatRule>
  selectOptions: Record<string, readonly string[]>
}

export interface PropertyResolveContext {
  locale: string
  now: number
  tagColorOf?: (name: string) => string | null | undefined
}

export type ColorSlot = 'theme' | 'transparent' | 'color'

export interface ResolvedPropertyItem {
  raw: string
  display: string
  formatted: boolean
  pill: string | null
  pillSlot: ColorSlot
  textColor: string | null
  textSlot: ColorSlot
  dateShape: DateShape | null
  relative: RelativeDate
}

export interface ResolvedProperty {
  key: string
  kind: PropertyValueKind
  value: unknown
  items: ResolvedPropertyItem[]
  display: string
  hidden: boolean
  hiddenReason: 'property' | 'empty' | null
  empty: boolean
  markdown: boolean
  formatted: boolean
  options: readonly string[]
  progress: { value: number; max: number; percent: number; variant: 'bar' | 'circle' } | null
  pill: string | null
  pillSlot: ColorSlot
  textColor: string | null
  textSlot: ColorSlot
  dateShape: DateShape | null
  relative: RelativeDate
}


function storedColor(value: string | null | undefined): { color: string | null; slot: ColorSlot } {
  if (!value || value === 'default')
    return { color: null, slot: 'theme' }
  if (value === 'none')
    return { color: null, slot: 'transparent' }
  return { color: value, slot: 'color' }
}

export const ACCENT_COLOR_TOKEN = 'accent'

export const DEFAULT_PILL_ALPHA = '2b';


export function propertyColorCss(stored: string): string {
  return stored === ACCENT_COLOR_TOKEN ? 'var(--accent)' : stored
}


export function propertyPillCss(stored: string): string {
  return stored === ACCENT_COLOR_TOKEN ? 'var(--accent-soft)' : `${stored}${DEFAULT_PILL_ALPHA}`
}


export function propertySwatchCss(stored: string): string {
  return propertyPillCss(stored)
}


export function settingKey(name: string): string {
  return name.trim().toLocaleLowerCase()
}


export function styleSettingsOf(properties: {
  enabled: boolean
  colors: PropertyStyleSettings['colors']
  hidden: readonly string[]
  hiddenWhenEmpty: readonly string[]
  hideAllEmpty: boolean
  useCustomDateFormats: boolean
  dateFormat: string
  dateTimeFormat: string
  relativeDateColors: boolean
  datePastColor: string | null
  datePresentColor: string | null
  dateFutureColor: string | null
  progress: PropertyStyleSettings['progress']
  formats: PropertyStyleSettings['formats']
  selectOptions: PropertyStyleSettings['selectOptions']
}): PropertyStyleSettings {
  return {
    enabled: properties.enabled,
    colors: properties.colors,
    hidden: properties.hidden,
    hiddenWhenEmpty: properties.hiddenWhenEmpty,
    hideAllEmpty: properties.hideAllEmpty,
    customDateFormats: properties.useCustomDateFormats,
    dateFormat: properties.dateFormat,
    dateTimeFormat: properties.dateTimeFormat,
    relativeDateColors: properties.relativeDateColors,
    dateColors: {
      past: properties.datePastColor,
      present: properties.datePresentColor,
      future: properties.dateFutureColor,
    },
    progress: properties.progress,
    formats: properties.formats,
    selectOptions: properties.selectOptions,
  };
}


export function decorationNamesOf(properties: {
  enabled: boolean
  bannerProperty: string
  iconProperty: string
  coverProperties: readonly string[]
  coverShapeProperty: string
  coverPositionProperty: string
  bannerPositionProperty: string
}): NotePropertyNames {
  if (!properties.enabled)
    return { ...DEFAULT_PROPERTY_NAMES, banner: '', icon: '', cover: [] };
  return {
    banner: properties.bannerProperty,
    icon: properties.iconProperty,
    cover: properties.coverProperties.filter(Boolean),
    coverShape: properties.coverShapeProperty,
    coverPosition: properties.coverPositionProperty,
    bannerPosition: properties.bannerPositionProperty,
  };
}


export function decorationDefaultsOf(properties: {
  coverShape: DecorationDefaults['coverShape']
  coverPosition: DecorationDefaults['coverPosition']
  bannerPosition: number
}): DecorationDefaults {
  return {
    coverShape: properties.coverShape,
    coverPosition: properties.coverPosition,
    bannerPosition: properties.bannerPosition,
  };
}


function colorRulesFor(settings: PropertyStyleSettings, key: string, isTags: boolean): Record<string, PropertyColorRule> | undefined {
  const byName = settings.colors[settingKey(key)]
  if (isTags)
    return { ...(settings.colors.tags ?? {}), ...(byName ?? {}) }
  return byName
}


function colorFor(
  settings: PropertyStyleSettings,
  key: string,
  value: string,
  isTags: boolean,
  tagColorOf?: (name: string) => string | null | undefined,
): PropertyColorRule {
  const rules = colorRulesFor(settings, key, isTags)
  const stored = rules?.[value]
  if (stored)
    return stored
  if (isTags && tagColorOf) {
    const fromRegistry = tagColorOf(value)
    if (fromRegistry)
      return { text: fromRegistry }
  }
  return {}
}


function applyFormat(
  rule: PropertyFormatRule | undefined,
  key: string,
  value: string,
  context: PropertyResolveContext,
): { display: string; formatted: boolean } {
  const template = rule?.template
  if (!template || !value)
    return { display: value, formatted: false }
  const rendered = formatPropertyValue({
    template,
    propertyName: key,
    propertyValue: value,
    locale: context.locale,
    now: context.now,
  })
  return rendered === null || rendered === value
    ? { display: value, formatted: false }
    : { display: rendered, formatted: true }
}


function formatDisplayDate(value: string, shape: DateShape, settings: PropertyStyleSettings, locale: string): string {
  const pattern = shape === 'date' ? settings.dateFormat : settings.dateTimeFormat
  if (!pattern)
    return value
  const parsed = parsePropertyValueDate(value)
  if (!parsed)
    return value
  return formatDateStamp(parsed.time, pattern, locale) || value
}


function progressFor(
  settings: PropertyStyleSettings,
  key: string,
  value: unknown,
  data: Record<string, unknown>,
): ResolvedProperty['progress'] {
  const rule = settings.progress[settingKey(key)]
  if (!rule)
    return null
  const amount = typeof value === 'number' ? value : Number(String(value ?? '').trim())
  if (!Number.isFinite(amount))
    return null
  let max = typeof rule.max === 'number' && Number.isFinite(rule.max) && rule.max !== 0 ? rule.max : 0
  if (!max && rule.maxProperty) {
    const named = data[rule.maxProperty]
    const candidate = typeof named === 'number' ? named : Number(String(named ?? '').trim())
    if (Number.isFinite(candidate) && candidate !== 0)
      max = candidate
  }
  if (!max)
    max = 100
  const percent = Math.max(0, Math.min(100, Math.round((amount / max) * 100)))
  return { value: amount, max, percent, variant: rule.variant === 'circle' ? 'circle' : 'bar' }
}


export function resolveProperties(
  data: Record<string, unknown>,
  settings: PropertyStyleSettings,
  context: PropertyResolveContext,
): ResolvedProperty[] {
  const hidden = new Set(settings.hidden.map(settingKey))
  const hiddenWhenEmpty = new Set(settings.hiddenWhenEmpty.map(settingKey))
  return Object.entries(data).map(([key, value]) => resolveProperty(key, value, data, settings, context, hidden, hiddenWhenEmpty))
}


export function resolveProperty(
  key: string,
  value: unknown,
  data: Record<string, unknown>,
  settings: PropertyStyleSettings,
  context: PropertyResolveContext,
  hidden?: Set<string>,
  hiddenWhenEmpty?: Set<string>,
): ResolvedProperty {
  const knownHidden = hidden ?? new Set(settings.hidden.map(settingKey))
  const knownWhenEmpty = hiddenWhenEmpty ?? new Set(settings.hiddenWhenEmpty.map(settingKey))
  const kind = propertyValueKind(value, key)
  const isTags = kind === 'tags'
  const empty = isPropertyEmpty(value)
  const formatRule = settings.formats[settingKey(key)]
  const rawValues = kind === 'object' ? [displayFallback(value)] : propertyValuesOf(value)
  const items = rawValues.map((raw) => resolveItem(raw, key, kind, isTags, settings, context, formatRule))
  const display = items.map((item) => item.display).join(isTags || kind === 'array' ? ', ' : '')
  const progress = kind === 'number' && settings.enabled
    ? progressFor(settings, key, value, data)
    : null
  const reason = settings.enabled && knownHidden.has(settingKey(key))
    ? 'property'
    : settings.enabled && empty && (settings.hideAllEmpty || knownWhenEmpty.has(settingKey(key)))
      ? 'empty'
      : null
  return {
    key,
    kind,
    value,
    items,
    display,
    hidden: reason !== null,
    hiddenReason: reason,
    empty,
    markdown: settings.enabled && formatRule?.markdown === true,
    formatted: items.some((item) => item.formatted),
    options: settings.enabled ? settings.selectOptions[settingKey(key)] ?? [] : [],
    progress,
    pill: items.length === 1 ? items[0]?.pill ?? null : null,
    pillSlot: items.length === 1 ? items[0]?.pillSlot ?? 'theme' : 'theme',
    textColor: items.length === 1 ? items[0]?.textColor ?? null : null,
    textSlot: items.length === 1 ? items[0]?.textSlot ?? 'theme' : 'theme',
    dateShape: items.length === 1 ? items[0]?.dateShape ?? null : null,
    relative: items.length === 1 ? items[0]?.relative ?? 'none' : 'none',
  }
}

function displayFallback(value: unknown): string {
  try {
    return JSON.stringify(value) ?? ''
  }
  catch {
    return String(value)
  }
}

function resolveItem(
  raw: string,
  key: string,
  kind: PropertyValueKind,
  isTags: boolean,
  settings: PropertyStyleSettings,
  context: PropertyResolveContext,
  formatRule: PropertyFormatRule | undefined,
): ResolvedPropertyItem {
  const shape = kind === 'text' ? dateShapeOf(raw) : null
  const relative = shape && settings.enabled ? relativeDateOf(raw, context.now) : 'none'
  const formatted = settings.enabled ? applyFormat(formatRule, key, raw, context) : { display: raw, formatted: false }
  const dated = settings.enabled && shape && settings.customDateFormats
    ? formatDisplayDate(raw, shape, settings, context.locale)
    : formatted.display
  const rules: PropertyColorRule = settings.enabled ? colorFor(settings, key, raw, isTags, context.tagColorOf) : {}
  const pill = storedColor(rules.pill)
  const pickedText = rules.text || (settings.enabled && settings.relativeDateColors && shape && relative !== 'none'
    ? settings.dateColors[relative] ?? ''
    : '')
  const textColor = storedColor(pickedText || undefined)
  return {
    raw,
    display: dated || raw,
    pill: pill.color,
    pillSlot: pill.slot,
    textColor: textColor.slot === 'color' ? textColor.color : null,
    textSlot: textColor.slot,
    dateShape: shape,
    relative,
    formatted: formatted.formatted,
  }
}
