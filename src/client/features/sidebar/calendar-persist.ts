export type CalendarView = 'month' | 'weeks' | 'year'


interface CalendarPersistState {
  collapsed: boolean
  view: CalendarView
}

export const CALENDAR_PERSIST_KEY = 'inkstone.sidebar-calendar.v1'

export function loadCalendarPersist(storage: Pick<Storage, 'getItem'> | null = defaultStorage()): CalendarPersistState {
  try {
    const raw = storage?.getItem(CALENDAR_PERSIST_KEY)
    if (!raw)
      return { collapsed: false, view: 'month' }
    const value = JSON.parse(raw) as { collapsed?: unknown; view?: unknown }
    return {
      collapsed: value.collapsed === true,
      view: value.view === 'weeks' ? 'weeks' : value.view === 'year' ? 'year' : 'month',
    }
  }
  catch {
    return { collapsed: false, view: 'month' }
  }
}

export function saveCalendarPersist(state: CalendarPersistState, storage: Pick<Storage, 'setItem'> | null = defaultStorage()): void {
  try {
    storage?.setItem(CALENDAR_PERSIST_KEY, JSON.stringify(state))
  }
  catch {
    // Quota or private-mode writes can throw; the calendar view stays authoritative in memory.
  }
}

function defaultStorage(): Pick<Storage, 'getItem' | 'setItem'> | null {
  return typeof localStorage === 'undefined' ? null : localStorage
}