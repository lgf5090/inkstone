import { parseFrontMatter } from './markdown-utils'
import { parsePropertyValueDate, propertyDisplayText, propertyValueKind } from './property-values'

const PROPERTY_KEYS_MAX = 100
const PROPERTY_VALUES_MAX = 50
const PROPERTY_KEY_CHARS_MAX = 128
const PROPERTY_TEXT_CHARS_MAX = 500

export interface IndexedNoteProperty {
  key: string
  keyKey: string
  ordinal: number
  kind: string
  array: boolean
  text: string | null
  number: number | null
  boolean: number | null
  date: number | null
}

export function indexNoteProperties(content: string): IndexedNoteProperty[] {
  const parsed = parseFrontMatter(content)
  if (!parsed.lineOffset || parsed.errors.length || !parsed.data || typeof parsed.data !== 'object' || Array.isArray(parsed.data)) return []
  const rows: IndexedNoteProperty[] = []
  for (const [rawKey, value] of Object.entries(parsed.data)) {
    if (rows.length >= PROPERTY_KEYS_MAX) break
    const key = rawKey.trim().slice(0, PROPERTY_KEY_CHARS_MAX)
    if (!key) continue
    const keyKey = key.toLocaleLowerCase()
    const values = Array.isArray(value) ? value : [value]
    for (const [ordinal, item] of (values.length ? values : ['']).slice(0, PROPERTY_VALUES_MAX).entries()) {
      const kind = propertyValueKind(item, key)
      rows.push({
        key,
        keyKey,
        ordinal,
        kind,
        array: Array.isArray(value),
        text: propertyDisplayText(item).slice(0, PROPERTY_TEXT_CHARS_MAX),
        number: typeof item === 'number' && Number.isFinite(item) ? item : null,
        boolean: typeof item === 'boolean' ? Number(item) : null,
        date: parsePropertyValueDate(item)?.time ?? null,
      })
    }
  }
  return rows
}

export function notePropertyRowsJson(rows: readonly IndexedNoteProperty[]): string {
  return JSON.stringify(rows)
}
