import { isOfficeFileType, type OfficeFileType } from '@shared/office/constants'

export type OfficeViewMode = 'list' | 'card' | 'gallery'
export type OfficeSortKey = 'updated' | 'name' | 'created' | 'type' | 'size'
export type OfficeSortDirection = 'asc' | 'desc'
/** The type tab strip's value: one product, or every product. */
export type OfficeFileTypeFilter = OfficeFileType | 'all'

export const OFFICE_VIEW_MODES: readonly OfficeViewMode[] = ['list', 'card', 'gallery']
export const OFFICE_SORT_KEYS: readonly OfficeSortKey[] = ['updated', 'name', 'created', 'type', 'size']
export const OFFICE_SORT_DIRECTIONS: readonly OfficeSortDirection[] = ['asc', 'desc']

/** `lite` registers only the open-source packages: no watermark, no Pro features. */
export type OfficeBuild = 'full' | 'lite'

export const OFFICE_BUILDS: readonly OfficeBuild[] = ['full', 'lite']
export const OFFICE_AUTOSAVE_DELAYS: readonly number[] = [600, 1200, 2000]

export interface OfficePrefs {
  viewMode: OfficeViewMode
  sortKey: OfficeSortKey
  sortDir: OfficeSortDirection
  showCheckboxes: boolean
  /** Which package set an editor registers; a change takes effect on the next mount. */
  build: OfficeBuild
  /** The reader's own Univer license; blank means the Pro watermark stays. */
  license: string
  autosaveDelayMs: number
  restoreTabs: boolean
  openSplitByDefault: boolean
  /** Apply the assistant's edit plans without asking first. Off by default: a write is a decision. */
  autoApplyPlans: boolean
}

export const DEFAULT_OFFICE_PREFS: OfficePrefs = {
  viewMode: 'list',
  sortKey: 'updated',
  sortDir: 'desc',
  showCheckboxes: true,
  build: 'full',
  license: '',
  autosaveDelayMs: 1200,
  restoreTabs: true,
  openSplitByDefault: false,
  autoApplyPlans: false,
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
  const autosaveDelayMs = OFFICE_AUTOSAVE_DELAYS.includes(value.autosaveDelayMs as number)
    ? value.autosaveDelayMs as number
    : DEFAULT_OFFICE_PREFS.autosaveDelayMs
  return {
    viewMode,
    sortKey,
    sortDir,
    showCheckboxes: typeof value.showCheckboxes === 'boolean' ? value.showCheckboxes : DEFAULT_OFFICE_PREFS.showCheckboxes,
    build: OFFICE_BUILDS.includes(value.build as OfficeBuild) ? value.build as OfficeBuild : DEFAULT_OFFICE_PREFS.build,
    license: typeof value.license === 'string' ? value.license.slice(0, 4096) : DEFAULT_OFFICE_PREFS.license,
    autosaveDelayMs,
    restoreTabs: typeof value.restoreTabs === 'boolean' ? value.restoreTabs : DEFAULT_OFFICE_PREFS.restoreTabs,
    openSplitByDefault: typeof value.openSplitByDefault === 'boolean' ? value.openSplitByDefault : DEFAULT_OFFICE_PREFS.openSplitByDefault,
    autoApplyPlans: typeof value.autoApplyPlans === 'boolean' ? value.autoApplyPlans : DEFAULT_OFFICE_PREFS.autoApplyPlans,
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