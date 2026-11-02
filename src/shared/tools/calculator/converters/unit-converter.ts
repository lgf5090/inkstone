import { UNIT_CATEGORIES, UNIT_BY_ID, UNIT_FACTORS, EXPLICIT_CONVERSIONS, unitsForCategory } from './units'
import type { SupplementaryResult, UnitCategoryDef, UnitDef, UnitPreference } from '../types'
import { UNIT_MAX_DIGITS, UNIT_MIN_DECIMAL, UNIT_OPTIMAL_DECIMAL, UNIT_OPTIMAL_DIGITS } from '../contract'

export interface ConversionData {
  ratio: number
  offset: number
  offsetFirst: boolean
}

export function getUnitCategory(categoryId: string): UnitCategoryDef | undefined {
  return UNIT_CATEGORIES.find((category) => category.id === categoryId)
}

export function getUnitsForCategory(categoryId: string): UnitDef[] {
  return unitsForCategory(categoryId)
}

export function getConversionData(fromUnitId: number, toUnitId: number): ConversionData {
  if (fromUnitId === toUnitId) return { ratio: 1, offset: 0, offsetFirst: false }
  const explicit = EXPLICIT_CONVERSIONS[fromUnitId]?.[toUnitId]
  if (explicit) return explicit
  const from = UNIT_BY_ID.get(fromUnitId)
  const to = UNIT_BY_ID.get(toUnitId)
  if (!from || !to) return { ratio: 1, offset: 0, offsetFirst: false }
  const fromFactor = from.factor ?? UNIT_FACTORS[from.categoryId]?.[fromUnitId]
  const toFactor = to.factor ?? UNIT_FACTORS[to.categoryId]?.[toUnitId]
  if (fromFactor === undefined || toFactor === undefined || toFactor === 0) {
    return { ratio: 1, offset: 0, offsetFirst: false }
  }
  return { ratio: fromFactor / toFactor, offset: 0, offsetFirst: false }
}

export function convertUnitValue(value: number, fromUnitId: number, toUnitId: number): number {
  const data = getConversionData(fromUnitId, toUnitId)
  return data.offsetFirst ? (value + data.offset) * data.ratio : value * data.ratio + data.offset
}

export function roundSignificantDigits(value: number, digits: number): string {
  if (!Number.isFinite(value)) return '0'
  if (value === 0) return '0'
  if (digits <= 0) {
    const rounded = Math.round(value)
    return Object.is(rounded, -0) ? '0' : String(rounded)
  }
  const magnitude = Math.floor(Math.log10(Math.abs(value)))
  const factor = 10 ** (digits - 1 - magnitude)
  const rounded = Math.round(value * factor) / factor
  const text = rounded.toPrecision(Math.min(21, Math.max(digits, 1)))
  return trimTrailingZeros(text)
}

export function trimTrailingZeros(text: string): string {
  if (!text.includes('.') || /[eE]/.test(text)) return text
  return text.replace(/\.?0+$/, '')
}

export function toScientificNumber(value: number): string {
  if (!Number.isFinite(value) || value === 0) return '0'
  return value.toExponential(Math.max(0, UNIT_MAX_DIGITS - 1)).replace(/\.?0+e/, 'e').replace(/e\+?/, 'e')
}

export function getNumberDigits(text: string): number {
  const cleaned = text.replace(/^-/, '').replace(/\./g, '').replace(/^0+/, '')
  return cleaned.replace(/0+$/, '').length || 1
}

export function getNumberDigitsWholeNumberPart(value: number): number {
  if (!Number.isFinite(value) || value === 0) return 1
  const text = Math.abs(value).toFixed(0)
  return text.replace(/^0+/, '').length || 1
}

export function formatConverterValue(value: number, inputText: string, isCurrency: boolean): string {
  if (!Number.isFinite(value)) return '0'
  if (isCurrency) return trimTrailingZeros(roundSignificantDigits(value, UNIT_MAX_DIGITS))
  const whole = getNumberDigitsWholeNumberPart(value)
  if (whole > UNIT_MAX_DIGITS || (value !== 0 && Math.abs(value) < UNIT_MIN_DECIMAL)) {
    return toScientificNumber(value)
  }
  const inputDigits = getNumberDigits(inputText)
  let precision: number
  if (Math.abs(value) < UNIT_OPTIMAL_DECIMAL) precision = UNIT_MAX_DIGITS
  else {
    const digits = Math.max(UNIT_OPTIMAL_DIGITS, Math.min(UNIT_MAX_DIGITS, inputDigits))
    precision = digits > whole ? digits - whole : 0
  }
  return trimTrailingZeros(roundSignificantDigits(value, precision))
}

export function supplementaryResults(
  value: number,
  categoryId: string,
  fromUnitId: number,
  supportsNegative: boolean,
): SupplementaryResult[] {
  const units = getUnitsForCategory(categoryId).filter((unit) => unit.id !== fromUnitId)
  const regular: { result: SupplementaryResult; magnitude: number }[] = []
  const whimsical: { result: SupplementaryResult; magnitude: number }[] = []
  for (const unit of units) {
    const converted = convertUnitValue(value, fromUnitId, unit.id)
    const rounded = Math.abs(converted) < 100 ? roundSignificantDigits(converted, 2) : Math.abs(converted) < 1000 ? roundSignificantDigits(converted, 1) : roundSignificantDigits(converted, 0)
    if ((Number(rounded) !== 0 || supportsNegative) && Number.isFinite(converted)) {
      const entry = { result: { value: rounded, unitId: unit.id, isWhimsical: Boolean(unit.isWhimsical) }, magnitude: Math.abs(converted) }
      if (unit.isWhimsical) whimsical.push(entry)
      else regular.push(entry)
    }
  }
  regular.sort((left, right) => left.magnitude - right.magnitude)
  whimsical.sort((left, right) => left.magnitude - right.magnitude)
  return [...regular.map((entry) => entry.result), ...(whimsical[0] ? [whimsical[0].result] : [])]
}

export function defaultUnitPreferences(): UnitPreference[] {
  const preferences: UnitPreference[] = []
  for (const category of UNIT_CATEGORIES) {
    if (category.id === 'currency') continue
    const units = getUnitsForCategory(category.id)
    const source = units.find((unit) => unit.isConversionSource) ?? units[0]
    const target = units.find((unit) => unit.isConversionTarget) ?? units.find((unit) => unit.id !== source?.id) ?? units[1]
    if (source && target) preferences.push({ categoryId: category.id, fromUnitId: source.id, toUnitId: target.id })
  }
  return preferences
}
