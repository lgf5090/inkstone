import { calendarStorageKey } from './calendar-storage'
import { createPersistedStore, readPersistedState } from './persisted-store'

export const CALENDAR_PREFS_STORAGE_KEY = calendarStorageKey('tree-preferences.v1')
const LEGACY_KEYS = ['inkstone.calendar-tree-preferences.v1'] as const

export interface CalendarTreePreferences {
  calendarVisible: boolean
  todoVisible: boolean
  inboxVisible: boolean
  showEmptyPeriods: boolean
}

const DEFAULT_PREFERENCES: CalendarTreePreferences = {
  calendarVisible: true,
  todoVisible: true,
  inboxVisible: true,
  showEmptyPeriods: false,
}

function booleanPreference(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function normalizePreferences(value: unknown): CalendarTreePreferences {
  const parsed = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Partial<CalendarTreePreferences>
    : {}
  return {
    calendarVisible: booleanPreference(parsed.calendarVisible, DEFAULT_PREFERENCES.calendarVisible),
    todoVisible: booleanPreference(parsed.todoVisible, DEFAULT_PREFERENCES.todoVisible),
    inboxVisible: booleanPreference(parsed.inboxVisible, DEFAULT_PREFERENCES.inboxVisible),
    showEmptyPeriods: booleanPreference(parsed.showEmptyPeriods, DEFAULT_PREFERENCES.showEmptyPeriods),
  }
}

export function loadCalendarPrefs(storage: Storage | null = typeof localStorage === 'undefined' ? null : localStorage): CalendarTreePreferences {
  return readPersistedState(CALENDAR_PREFS_STORAGE_KEY, DEFAULT_PREFERENCES, normalizePreferences, storage, LEGACY_KEYS)
}

const preferences = createPersistedStore(CALENDAR_PREFS_STORAGE_KEY, DEFAULT_PREFERENCES, normalizePreferences, LEGACY_KEYS)

export function saveCalendarPrefs(patch: Partial<CalendarTreePreferences>): void {
  preferences.setState(patch)
}

export function useCalendarTreePreferences(): CalendarTreePreferences {
  return preferences.useStore(state => state)
}
