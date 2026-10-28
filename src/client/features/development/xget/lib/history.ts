import { XGET_PLATFORM_BY_KEY } from '@shared/development/xget/catalog'
import { XGET_HISTORY_LIMIT } from '@shared/development/xget/constants'

export interface XgetHistoryItem {
  url: string
  result: string
  key: string
  time: number
}

const KEY_PREFIX = 'inkstone.development.xget.history'

function storageKey(userId: string): string {
  return `${KEY_PREFIX}.${userId}`
}

function validItem(value: unknown): value is XgetHistoryItem {
  if (!value || typeof value !== 'object') return false
  const item = value as Record<string, unknown>
  return (
    typeof item.url === 'string' &&
    item.url.length > 0 &&
    item.url.length <= 4096 &&
    typeof item.result === 'string' &&
    item.result.length > 0 &&
    item.result.length <= 4096 &&
    typeof item.key === 'string' &&
    item.key in XGET_PLATFORM_BY_KEY &&
    typeof item.time === 'number' &&
    Number.isFinite(item.time) &&
    item.time > 0
  )
}

export function loadXgetHistory(userId: string | null | undefined): XgetHistoryItem[] {
  if (!userId || typeof localStorage === 'undefined') return []
  try {
    const raw = localStorage.getItem(storageKey(userId))
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(validItem).slice(0, XGET_HISTORY_LIMIT)
  } catch (error) {
    console.warn('[inkstone] Xget history could not be read:', error)
    return []
  }
}

export function saveXgetHistory(
  userId: string | null | undefined,
  items: XgetHistoryItem[],
): XgetHistoryItem[] {
  const next = items.filter(validItem).slice(0, XGET_HISTORY_LIMIT)
  if (!userId || typeof localStorage === 'undefined') return next
  try {
    localStorage.setItem(storageKey(userId), JSON.stringify(next))
  } catch (error) {
    console.warn('[inkstone] Xget history could not be saved:', error)
  }
  return next
}

export function prependXgetHistory(
  userId: string | null | undefined,
  items: XgetHistoryItem[],
  item: XgetHistoryItem,
): XgetHistoryItem[] {
  return saveXgetHistory(userId, [item, ...items].slice(0, XGET_HISTORY_LIMIT))
}

export function clearXgetHistory(userId: string | null | undefined): void {
  if (!userId || typeof localStorage === 'undefined') return
  try {
    localStorage.removeItem(storageKey(userId))
  } catch (error) {
    console.warn('[inkstone] Xget history could not be cleared:', error)
  }
}
