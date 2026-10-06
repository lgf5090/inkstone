import { useSyncExternalStore } from 'react'

export type YearGridColumnsPref = 'auto' | '3' | '4'

export const STORAGE_KEY = 'inkstone.year-grid-columns.v1'

const listeners = new Set<() => void>()
let pref: YearGridColumnsPref = load()

function load(): YearGridColumnsPref {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as unknown
      if (parsed === 'auto')
        return 'auto'
      if (parsed === '3' || parsed === 3)
        return '3'
      if (parsed === '4' || parsed === 4)
        return '4'
    }
  }
  catch {
    // Corrupt or missing stored prefs fall back to the default below.
  }
  return 'auto'
}

function save(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(pref))
  }
  catch {
    // Quota or private-mode writes can throw; the pref stays authoritative in memory.
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function useYearGridColumns(): YearGridColumnsPref {
  return useSyncExternalStore(subscribe, () => pref, () => pref)
}

export function setYearGridColumns(next: YearGridColumnsPref): void {
  pref = next
  save()
  listeners.forEach((listener) => listener())
}

export function cycleYearGridColumns(current: YearGridColumnsPref): YearGridColumnsPref {
  return current === 'auto' ? '3' : current === '3' ? '4' : 'auto'
}