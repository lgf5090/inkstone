/**
 * The Cloudflare app's copy, loaded when the app is opened.
 *
 * The module carries about 1,200 keys per language. Folding them into the notebook's start-up
 * catalogue would make every reader pay for an app most of them never open, so each language is its
 * own chunk and `CloudflareApp` waits for the current one before drawing a screen. Until it answers,
 * `cfT` returns the key itself — readable in development, and never seen by a reader because the app
 * shows a loading state until the catalogue is there.
 */
import { useSyncExternalStore } from 'react'
import type { AppLocale } from '@shared/types'
import type { EN_US_CLOUDFLARE } from '@shared/locales/en-US-cloudflare'

export type CloudflareMessageKey = keyof typeof EN_US_CLOUDFLARE

type Params = Record<string, string | number | boolean | null | undefined>

let table: Record<string, string> = {}
let activeLocale: AppLocale | null = null
let wantedLocale: AppLocale | null = null
let version = 0
let inFlight: { locale: AppLocale; promise: Promise<void> } | null = null
const listeners = new Set<() => void>()

async function load(locale: AppLocale): Promise<Record<string, string>> {
  if (locale === 'zh-CN') {
    const module = await import('@shared/locales/zh-CN-cloudflare')
    return module.ZH_CN_CLOUDFLARE as Record<string, string>
  }
  const module = await import('@shared/locales/en-US-cloudflare')
  return module.EN_US_CLOUDFLARE as Record<string, string>
}

/**
 * Load one language, or do nothing when it is the one already loaded.
 *
 * A locale switch while a load is in flight is the case that needs the `wantedLocale` check: the
 * older load can resolve after the newer one started, and applying it would leave the interface in
 * the language the reader just left.
 */
export function ensureCloudflareMessages(locale: AppLocale): Promise<void> {
  wantedLocale = locale
  if (activeLocale === locale) return Promise.resolve()
  if (inFlight?.locale === locale) return inFlight.promise
  const promise = (async () => {
    const next = await load(locale)
    if (wantedLocale !== locale) return
    table = next
    activeLocale = locale
    version += 1
    listeners.forEach((listener) => listener())
  })().finally(() => {
    if (inFlight?.promise === promise) inFlight = null
  })
  inFlight = { locale, promise }
  return promise
}

/** The language actually in memory, or null before the first load lands. */
export function cloudflareMessagesLocale(): AppLocale | null {
  return activeLocale
}

export function cfT(key: CloudflareMessageKey, params?: Params): string {
  const template = table[key] ?? key
  if (!params) return template
  return template.replace(/\{([A-Za-z0-9_]+)\}/g, (whole, name: string) => {
    const value = params[name]
    return value == null ? whole : String(value)
  })
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Re-render a component when the catalogue arrives or the language changes. */
export function useCfT(): typeof cfT {
  useSyncExternalStore(subscribe, () => version, () => version)
  return cfT
}

export function useCloudflareMessagesVersion(): number {
  return useSyncExternalStore(subscribe, () => version, () => version)
}
