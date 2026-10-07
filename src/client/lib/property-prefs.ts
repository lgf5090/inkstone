import type { PropertyColorChoice, PropertyFormatChoice, PropertyProgressChoice, PropertySettings } from '@shared/types'

export type ColorSlotName = 'pill' | 'text'

export const COLOR_NONE = 'none'

export const COLOR_DEFAULT = 'default'


export function colorPropertyKey(name: string): string {
  return name.trim().toLocaleLowerCase()
}

export function colorValueKey(value: string): string {
  return value.trim()
}

export function readColorRule(settings: PropertySettings, property: string, value: string): PropertyColorChoice | undefined {
  return settings.colors[colorPropertyKey(property)]?.[colorValueKey(value)]
}


export function withColor(
  settings: PropertySettings,
  property: string,
  value: string,
  slot: ColorSlotName,
  color: string | null,
): PropertySettings['colors'] {
  const propertyKey = colorPropertyKey(property)
  const valueKey = colorValueKey(value)
  if (!propertyKey || !valueKey)
    return settings.colors
  const rules = { ...(settings.colors[propertyKey] ?? {}) }
  const entry: PropertyColorChoice = { ...rules[valueKey] }
  const chosen = color === null ? COLOR_DEFAULT : color
  if (slot === 'pill')
    entry.pill = chosen
  else
    entry.text = chosen
  if ((entry.pill ?? COLOR_DEFAULT) === COLOR_DEFAULT && (entry.text ?? COLOR_DEFAULT) === COLOR_DEFAULT)
    delete rules[valueKey]
  else
    rules[valueKey] = entry
  const next = { ...settings.colors }
  if (Object.keys(rules).length)
    next[propertyKey] = rules
  else
    delete next[propertyKey]
  return next
}


export function withoutPropertyColors(settings: PropertySettings, property: string): PropertySettings['colors'] {
  const next = { ...settings.colors }
  delete next[colorPropertyKey(property)]
  return next
}


export function withName(list: readonly string[], name: string, on: boolean): string[] {
  const trimmed = name.trim()
  if (!trimmed)
    return [...list]
  const key = trimmed.toLocaleLowerCase()
  const kept = list.filter(item => item.toLocaleLowerCase() !== key)
  if (!on)
    return kept
  return kept.length === list.length ? [...list, trimmed] : [...list]
}


export function readProgressRule(settings: PropertySettings, property: string): PropertyProgressChoice | undefined {
  return settings.progress[colorPropertyKey(property)]
}


export function withProgressRule(
  settings: PropertySettings,
  property: string,
  rule: PropertyProgressChoice | null,
): PropertySettings['progress'] {
  const key = colorPropertyKey(property)
  const next = { ...settings.progress }
  if (!key)
    return settings.progress
  if (rule === null)
    delete next[key]
  else
    next[key] = rule
  return next
}


export function readFormatRule(settings: PropertySettings, property: string): PropertyFormatChoice | undefined {
  return settings.formats[colorPropertyKey(property)]
}


export function withFormatRule(
  settings: PropertySettings,
  property: string,
  patch: Partial<PropertyFormatChoice> | null,
): PropertySettings['formats'] {
  const key = colorPropertyKey(property)
  const next = { ...settings.formats }
  if (!key)
    return settings.formats
  if (patch === null) {
    delete next[key]
    return next
  }
  const merged: PropertyFormatChoice = { ...next[key], ...patch }
  if (merged.template === undefined)
    delete merged.template
  if (merged.markdown === undefined)
    delete merged.markdown
  if (merged.template?.trim() === '')
    delete merged.template
  if (merged.markdown === false)
    delete merged.markdown
  if (merged.template === undefined && merged.markdown === undefined)
    delete next[key]
  else
    next[key] = merged
  return next
}


export function readSelectOptions(settings: PropertySettings, property: string): string[] {
  return settings.selectOptions[colorPropertyKey(property)] ?? []
}


export function withSelectOptions(
  settings: PropertySettings,
  property: string,
  options: readonly string[] | null,
): PropertySettings['selectOptions'] {
  const key = colorPropertyKey(property)
  const next = { ...settings.selectOptions }
  if (!key)
    return settings.selectOptions
  if (options === null) {
    delete next[key]
    return next
  }
  const cleaned: string[] = []
  const seen = new Set<string>()
  for (const option of options) {
    const value = option.trim()
    if (!value || seen.has(value.toLocaleLowerCase()))
      continue
    seen.add(value.toLocaleLowerCase())
    cleaned.push(value)
  }
  if (cleaned.length)
    next[key] = cleaned
  else
    delete next[key]
  return next
}
