import { isOfficeFileType, type OfficeFileType } from '@shared/office/constants'

export type OfficeViewMode = 'list' | 'card' | 'gallery'
export type OfficeSortKey = 'updated' | 'name' | 'created' | 'type' | 'size'
export type OfficeSortDirection = 'asc' | 'desc'
/** The type tab strip's value: one product, or every product. */
export type OfficeFileTypeFilter = OfficeFileType | 'all'

export const OFFICE_VIEW_MODES: readonly OfficeViewMode[] = ['list', 'card', 'gallery']
export const OFFICE_SORT_KEYS: readonly OfficeSortKey[] = ['updated', 'name', 'created', 'type', 'size']
export const OFFICE_SORT_DIRECTIONS: readonly OfficeSortDirection[] = ['asc', 'desc']

export interface OfficePrefs {
  viewMode: OfficeViewMode
  sortKey: OfficeSortKey
  sortDir: OfficeSortDirection
  showCheckboxes: boolean
}

export const DEFAULT_OFFICE_PREFS: OfficePrefs = {
  viewMode: 'list',
  sortKey: 'updated',
  sortDir: 'desc',
  showCheckboxes: true,
}

const PREFS_VERSION = 'v1'

export function officePrefsKey(userId: string): string {
  return `inkstone.office.prefs.${PREFS_VERSION}.${userId}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/** A stored preference is only trusted for the options this screen actually has. */
export function parseOfficePrefs(value: unknown): OfficePrefs {
  if (!isRecord(value)) return { ...DEFAULT_OFFICE_PREFS }
  const viewMode = OFFICE_VIEW_MODES.includes(value.viewMode as OfficeViewMode)
    ? value.viewMode as OfficeViewMode
    : DEFAULT_OFFICE_PREFS.viewMode
  const sortKey = OFFICE_SORT_KEYS.includes(value.sortKey as OfficeSortKey)
    ? value.sortKey as OfficeSortKey
    : DEFAULT_OFFICE_PREFS.sortKey
  const sortDir = OFFICE_SORT_DIRECTIONS.includes(value.sortDir as OfficeSortDirection)
    ? value.sortDir as OfficeSortDirection
    : DEFAULT_OFFICE_PREFS.sortDir
  return {
    viewMode,
    sortKey,
    sortDir,
    showCheckboxes: typeof value.showCheckboxes === 'boolean' ? value.showCheckboxes : DEFAULT_OFFICE_PREFS.showCheckboxes,
  }
}

export function readOfficePrefs(userId: string): OfficePrefs {
  try {
    const raw = localStorage.getItem(officePrefsKey(userId))
    return parseOfficePrefs(raw ? JSON.parse(raw) : null)
  } catch {
    return { ...DEFAULT_OFFICE_PREFS }
  }
}

export function writeOfficePrefs(userId: string, prefs: OfficePrefs): void {
  try {
    localStorage.setItem(officePrefsKey(userId), JSON.stringify(prefs))
  } catch {
    // A full or disabled localStorage only costs the preference, never the files.
    console.warn('[inkstone] Office preferences could not be saved')
  }
}

export interface OfficeOpenTab {
  id: string
  type: OfficeFileType
  title: string
}

/** The workbench's open set, restored after a reload so a reader keeps their place. */
const OPEN_TABS_KEY = 'office-open-tabs'
export const OFFICE_OPEN_TABS_MAX = 20

export function readOfficeOpenTabs(): OfficeOpenTab[] {
  try {
    const raw = sessionStorage.getItem(OPEN_TABS_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    const seen = new Set<string>()
    const tabs: OfficeOpenTab[] = []
    for (const entry of parsed) {
      if (!isRecord(entry)) continue
      if (typeof entry.id !== 'string' || !entry.id || !isOfficeFileType(entry.type)) continue
      if (seen.has(entry.id)) continue
      seen.add(entry.id)
      tabs.push({
        id: entry.id,
        type: entry.type,
        title: typeof entry.title === 'string' && entry.title.trim() ? entry.title : entry.type,
      })
      if (tabs.length >= OFFICE_OPEN_TABS_MAX) break
    }
    return tabs
  } catch {
    return []
  }
}

export function writeOfficeOpenTabs(tabs: readonly OfficeOpenTab[]): void {
  try {
    sessionStorage.setItem(OPEN_TABS_KEY, JSON.stringify(tabs.slice(0, OFFICE_OPEN_TABS_MAX)))
  } catch {
    // The workbench still works without remembering its set across a reload.
    console.warn('[inkstone] Office open tabs could not be saved')
  }
}