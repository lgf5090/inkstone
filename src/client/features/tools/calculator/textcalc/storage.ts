import { DEFAULT_TEXTCALC_SETTINGS, type TextCalcSettings } from './engine'

const DOCUMENT_KEY = 'inkstone.tools.textcalc.document'
const SETTINGS_KEY = 'inkstone.tools.textcalc.settings'
const HISTORY_KEY = 'inkstone.tools.textcalc.history'

export const TEXTCALC_HISTORY_LIMIT = 30

export interface TextCalcHistoryEntry {
  id: string
  at: number
  text: string
  summary: string
  lines: number
}

function read(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    // A private window can refuse storage; the in-memory document still works for this visit.
    return null
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    // Best effort persistence; the current document stays authoritative.
  }
}

export function loadDocument(): string {
  return read(DOCUMENT_KEY) ?? ''
}

export function saveDocument(text: string): void {
  write(DOCUMENT_KEY, text)
}

export function loadSettings(): TextCalcSettings {
  const raw = read(SETTINGS_KEY)
  if (!raw) return { ...DEFAULT_TEXTCALC_SETTINGS }
  try {
    const parsed = JSON.parse(raw) as Partial<TextCalcSettings>
    return {
      angleMode: parsed.angleMode === 'deg' ? 'deg' : 'rad',
      precision: typeof parsed.precision === 'number' && parsed.precision >= 2 && parsed.precision <= 14
        ? Math.round(parsed.precision)
        : DEFAULT_TEXTCALC_SETTINGS.precision,
      thousands: parsed.thousands !== false,
      bases: parsed.bases !== false,
    }
  } catch {
    return { ...DEFAULT_TEXTCALC_SETTINGS }
  }
}

export function saveSettings(settings: TextCalcSettings): void {
  write(SETTINGS_KEY, JSON.stringify(settings))
}

export function loadHistory(): TextCalcHistoryEntry[] {
  const raw = read(HISTORY_KEY)
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as TextCalcHistoryEntry[]
    if (!Array.isArray(parsed)) return []
    return parsed.filter((entry) => (
      typeof entry?.id === 'string' &&
      typeof entry?.at === 'number' &&
      typeof entry?.text === 'string' &&
      typeof entry?.summary === 'string' &&
      typeof entry?.lines === 'number'
    )).slice(0, TEXTCALC_HISTORY_LIMIT)
  } catch {
    return []
  }
}

export function saveHistory(history: TextCalcHistoryEntry[]): void {
  write(HISTORY_KEY, JSON.stringify(history.slice(0, TEXTCALC_HISTORY_LIMIT)))
}

export function newHistoryEntry(text: string, summary: string): TextCalcHistoryEntry {
  const lines = text.length === 0 ? 0 : text.split(/\r?\n/).length
  return {
    id: `tc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
    at: Date.now(),
    text,
    summary,
    lines,
  }
}
