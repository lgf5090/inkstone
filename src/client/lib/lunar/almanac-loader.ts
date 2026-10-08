import { useSyncExternalStore } from 'react'
import type { AlmanacDay } from './festivals'

export interface AlmanacApi {
  almanacOf: (date: Date) => AlmanacDay | null
}

let api: AlmanacApi | null = null
let inflight: Promise<AlmanacApi | null> | null = null
const listeners = new Set<() => void>()

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function notify(): void {
  for (const listener of listeners)
    listener()
}

/**
 * Downloads the almanac at most once, and only when something asks for it. A reader who switches
 * both lunar labels and festival names off never issues this request, so the 1900-2100 tables and
 * the term solver stay out of their transfer entirely.
 */
export function requestAlmanac(): void {
  if (api !== null || inflight !== null)
    return
  inflight = import('./festivals').then((module) => {
    api = { almanacOf: module.almanacOf }
    inflight = null
    notify()
    return api
  }, () => {
    inflight = null
    return null
  })
}

export function almanacApi(): AlmanacApi | null {
  return api
}

/** The almanac, or null while it is switched off or still arriving. */
export function useAlmanac(enabled: boolean): AlmanacApi | null {
  if (enabled)
    requestAlmanac()
  return useSyncExternalStore(subscribe, () => (enabled ? api : null), () => null)
}
