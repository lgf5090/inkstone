import { useSyncExternalStore } from 'react'
import { weekStartFor, type WeekStartDay } from './time'

/** The stored form of each switch; 'auto' defers to the reader's language at render time. */
export type CalendarToggle = 'auto' | 'on' | 'off'

/** What the calendar itself is handed: every question already answered. */
export interface CalendarDisplayView {
  lunar: boolean
  festivals: boolean
  weekNumbers: boolean
  weekendTint: boolean
  todayCard: boolean
  streakStats: boolean
  showAdjacentDays: boolean
}

/** 'auto' defers to the reader's locale; a digit is that weekday's JS `getDay()` number. */
export type WeekStartPref = 'auto' | '0' | '1' | '2' | '3' | '4' | '5' | '6'

export const WEEK_START_PREFS: WeekStartPref[] = ['auto', '0', '1', '2', '3', '4', '5', '6']

export interface CalendarDisplayPrefs {
  lunarLabels: CalendarToggle
  festivals: CalendarToggle
  weekNumbers: boolean
  weekendTint: boolean
  todayCard: boolean
  streakStats: boolean
  showAdjacentDays: boolean
  weekStart: WeekStartPref
}

export const STORAGE_KEY = 'inkstone.calendar-display-prefs.v1'

export const DEFAULT_DISPLAY_PREFS: CalendarDisplayPrefs = {
  lunarLabels: 'auto',
  festivals: 'auto',
  weekNumbers: false,
  weekendTint: true,
  todayCard: true,
  streakStats: true,
  showAdjacentDays: true,
  weekStart: 'auto',
}

const TOGGLES: CalendarToggle[] = ['auto', 'on', 'off']

function toggle(value: unknown, fallback: CalendarToggle): CalendarToggle {
  return TOGGLES.includes(value as CalendarToggle) ? value as CalendarToggle : fallback
}

function flag(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function weekStartPref(value: unknown): WeekStartPref {
  return typeof value === 'string' && WEEK_START_PREFS.includes(value as WeekStartPref)
    ? value as WeekStartPref
    : DEFAULT_DISPLAY_PREFS.weekStart
}

function readStorage(): Storage | null {
  return typeof localStorage === 'undefined' ? null : localStorage
}

export function loadCalendarDisplayPrefs(storage: Storage | null = readStorage()): CalendarDisplayPrefs {
  const fallback = DEFAULT_DISPLAY_PREFS
  if (!storage)
    return { ...fallback }
  try {
    const raw = storage.getItem(STORAGE_KEY)
    if (!raw)
      return { ...fallback }
    const parsed = JSON.parse(raw) as Partial<CalendarDisplayPrefs> | null
    if (parsed === null || typeof parsed !== 'object')
      return { ...fallback }
    return {
      lunarLabels: toggle(parsed.lunarLabels, fallback.lunarLabels),
      festivals: toggle(parsed.festivals, fallback.festivals),
      weekNumbers: flag(parsed.weekNumbers, fallback.weekNumbers),
      weekendTint: flag(parsed.weekendTint, fallback.weekendTint),
      todayCard: flag(parsed.todayCard, fallback.todayCard),
      streakStats: flag(parsed.streakStats, fallback.streakStats),
      showAdjacentDays: flag(parsed.showAdjacentDays, fallback.showAdjacentDays),
      weekStart: weekStartPref(parsed.weekStart),
    }
  }
  catch {
    return { ...fallback }
  }
}

let current = loadCalendarDisplayPrefs()
const listeners = new Set<() => void>()

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useCalendarDisplayPrefs(): CalendarDisplayPrefs {
  return useSyncExternalStore(subscribe, () => current, () => current)
}

export function setCalendarDisplayPrefs(patch: Partial<CalendarDisplayPrefs>): void {
  current = { ...current, ...patch }
  const storage = readStorage()
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify(current))
  }
  catch {
  }
  for (const listener of listeners)
    listener()
}

/** 'auto' resolves to the reader's language: a Han interface asks for an almanac, others do not. */
export function resolveToggle(preference: CalendarToggle, locale: string): boolean {
  if (preference !== 'auto')
    return preference === 'on'
  return locale.toLowerCase().startsWith('zh')
}

export function resolveDisplay(prefs: CalendarDisplayPrefs, locale: string): CalendarDisplayView {
  return {
    lunar: resolveToggle(prefs.lunarLabels, locale),
    festivals: resolveToggle(prefs.festivals, locale),
    weekNumbers: prefs.weekNumbers,
    weekendTint: prefs.weekendTint,
    todayCard: prefs.todayCard,
    streakStats: prefs.streakStats,
    showAdjacentDays: prefs.showAdjacentDays,
  }
}

/** Which weekday opens the grids: the reader's answer, or the locale's. */
export function resolveWeekStart(preference: WeekStartPref, locale: string): WeekStartDay {
  return preference === 'auto' ? weekStartFor(locale) : Number(preference) as WeekStartDay
}
