import { useStore } from 'zustand'
import { createStore } from 'zustand/vanilla'

function readStorage(): Storage | null {
  return typeof localStorage === 'undefined' ? null : localStorage
}

export function readPersistedState<T extends object>(
  key: string,
  defaults: T,
  normalize: (value: unknown) => T,
  storage: Storage | null = readStorage(),
  legacyKeys: readonly string[] = [],
): T {
  if (!storage) return { ...defaults }
  for (const candidate of [key, ...legacyKeys]) {
    try {
      const raw = storage.getItem(candidate)
      if (raw !== null) return normalize(JSON.parse(raw))
    } catch (cause) {
      console.warn(`[inkstone] Could not read ${candidate}; using defaults.`, cause)
    }
  }
  return { ...defaults }
}

export function createPersistedStore<T extends object>(
  key: string,
  defaults: T,
  normalize: (value: unknown) => T,
  legacyKeys: readonly string[] = [],
) {
  const store = createStore<T>(() => readPersistedState(key, defaults, normalize, readStorage(), legacyKeys))
  const write = (state: T): void => {
    try {
      readStorage()?.setItem(key, JSON.stringify(state))
    } catch (cause) {
      console.warn(`[inkstone] Could not persist ${key}; the current session still uses the new value.`, cause)
    }
  }
  if (typeof window !== 'undefined') {
    window.addEventListener('storage', (event) => {
      if (event.storageArea !== localStorage) return
      if (event.key !== null && event.key !== key && !legacyKeys.includes(event.key)) return
      store.setState(readPersistedState(key, defaults, normalize, localStorage, legacyKeys))
    })
  }
  return {
    getState: store.getState,
    subscribe: store.subscribe,
    setState: (patch: Partial<T>): void => {
      const next = { ...store.getState(), ...patch }
      store.setState(next)
      write(next)
    },
    useStore: <U>(selector: (state: T) => U): U => useStore(store, selector),
  }
}
