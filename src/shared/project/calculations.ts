/**
 * The 21 column summaries (§3.3.1), ported from the reference's calculations.ts. Values come from the
 * card's value bag (or its stamps for the server-written time fields); numeric results round to two
 * decimals and timestamps normalize to whole minutes, matching the reference's display precision.
 */
import type { ProjectCalculation, ProjectCard, ProjectProperty } from './model'

const ROUNDED_DECIMAL_PLACES = 2

function round(value: number): number {
  const factor = 10 ** ROUNDED_DECIMAL_PLACES
  return Math.round(value * factor) / factor
}

function minuteStamp(value: number): number {
  return Math.floor(value / 60_000) * 60_000
}

function rawValue(card: ProjectCard, property: ProjectProperty): string {
  switch (property.type) {
    case 'createdTime': return String(card.createAt)
    case 'updatedTime': return String(card.updateAt)
    case 'createdBy': return card.createdBy
    case 'updatedBy': return card.modifiedBy
    default: return card.values[property.id] ?? ''
  }
}

function numericValues(cards: readonly ProjectCard[], property: ProjectProperty): number[] {
  return cards
    .map((card) => rawValue(card, property))
    .filter((raw) => raw.trim() !== '')
    .map((raw) => Number(raw))
    .filter((n) => Number.isFinite(n))
}

function dateValues(cards: readonly ProjectCard[], property: ProjectProperty): number[] {
  return cards.map((card) => {
    const raw = rawValue(card, property)
    if (!raw) return NaN
    try {
      const parsed: unknown = JSON.parse(raw)
      const from = (parsed as { from?: number })?.from
      if (typeof from === 'number') return from
    } catch { /* bare stamp */ }
    const stamp = Number(raw)
    return Number.isFinite(stamp) ? stamp : NaN
  }).filter((n) => Number.isFinite(n))
}

function percent(part: number, whole: number): string {
  return whole === 0 ? '0%' : `${round((part / whole) * 100)}%`
}

export function computeProjectCalculation(cards: readonly ProjectCard[], property: ProjectProperty, calculation: ProjectCalculation): string {
  const total = cards.length
  const values = cards.map((card) => rawValue(card, property))
  const empty = values.filter((v) => v === '').length
  const notEmpty = total - empty
  switch (calculation) {
    case 'none': return ''
    case 'count': return String(total)
    case 'countEmpty': return String(empty)
    case 'countNotEmpty': return String(notEmpty)
    case 'percentEmpty': return percent(empty, total)
    case 'percentNotEmpty': return percent(notEmpty, total)
    case 'countValue': return String(notEmpty)
    case 'countUniqueValue': return String(new Set(values.filter((v) => v !== '')).size)
    case 'countChecked': return String(values.filter((v) => v === 'true').length)
    case 'countUnchecked': return String(values.filter((v) => v === 'false').length)
    case 'percentChecked': return percent(values.filter((v) => v === 'true').length, total)
    case 'percentUnchecked': return percent(values.filter((v) => v === 'false').length, total)
    case 'sum': return String(round(numericValues(cards, property).reduce((a, b) => a + b, 0)))
    case 'average': {
      const nums = numericValues(cards, property)
      return nums.length ? String(round(nums.reduce((a, b) => a + b, 0) / nums.length)) : '0'
    }
    case 'median': {
      const nums = numericValues(cards, property).sort((a, b) => a - b)
      if (!nums.length) return '0'
      const mid = Math.floor(nums.length / 2)
      return String(round(nums.length % 2 ? nums[mid]! : (nums[mid - 1]! + nums[mid]!) / 2))
    }
    case 'min': {
      const nums = numericValues(cards, property)
      return nums.length ? String(round(Math.min(...nums))) : '0'
    }
    case 'max': {
      const nums = numericValues(cards, property)
      return nums.length ? String(round(Math.max(...nums))) : '0'
    }
    case 'range': {
      const nums = numericValues(cards, property)
      return nums.length ? String(round(Math.max(...nums) - Math.min(...nums))) : '0'
    }
    case 'earliest': {
      const dates = dateValues(cards, property)
      return dates.length ? String(minuteStamp(Math.min(...dates))) : ''
    }
    case 'latest': {
      const dates = dateValues(cards, property)
      return dates.length ? String(minuteStamp(Math.max(...dates))) : ''
    }
    case 'dateRange': {
      const dates = dateValues(cards, property)
      return dates.length ? String(minuteStamp(Math.max(...dates)) - minuteStamp(Math.min(...dates))) : ''
    }
    default: return ''
  }
}

/** Which summaries a property type offers, per the reference's per-type calculationOptions. */
export function calculationOptionsFor(property: ProjectProperty): ProjectCalculation[] {
  const base: ProjectCalculation[] = ['none', 'count', 'countEmpty', 'countNotEmpty', 'percentEmpty', 'percentNotEmpty', 'countValue', 'countUniqueValue']
  if (property.type === 'number') return [...base, 'sum', 'average', 'median', 'min', 'max', 'range']
  if (property.type === 'createdTime' || property.type === 'updatedTime') return [...base, 'earliest', 'latest', 'dateRange']
  if (property.type === 'checkbox') return [...base, 'countChecked', 'percentChecked', 'countUnchecked', 'percentUnchecked']
  return base
}