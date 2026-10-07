import { useSyncExternalStore } from 'react'

/**
 * Chinese first-letter search.
 *
 * Typing `qx` has to find the menu row for selecting all, and `ysms` the one for presentation mode.
 * That needs a Han-to-reading table, which is a dictionary rather than an algorithm, so it is a lazy
 * chunk: the app boots without it, `preloadPinyin` asks for it as soon as the shell is up, and every
 * matcher treats an unloaded dictionary as "no pinyin answer" rather than blocking on it.
 *
 * The one consequence of that is a search that ran before the chunk landed can have missed, so the
 * module publishes a version and the surfaces that own a search box subscribe to it — see
 * {@link usePinyinVersion}.
 */

/** What `pinyin-pro` exports for the one job this module has. */
type PinyinFn = typeof import('pinyin-pro').pinyin

/** Text longer than this is a note body, not a label; initials of a whole note are nobody's query. */
const PINYIN_TEXT_LIMIT = 200

/** How much label text the key cache may hold before it starts over, in source characters. */
const KEY_CACHE_BUDGET = 400_000

const HAN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff]/

let pinyinFn: PinyinFn | null = null
let pending: Promise<PinyinFn | null> | null = null
const subscribers = new Set<() => void>()
let version = 0

function notify(): void {
  version++
  for (const listener of [...subscribers]) listener()
}

/** Start the download if it has not started. Resolves to null when the chunk cannot be fetched. */
export function preloadPinyin(): Promise<PinyinFn | null> {
  if (pinyinFn) return Promise.resolve(pinyinFn)
  pending ??= import('pinyin-pro')
    .then((module) => {
      pinyinFn = module.pinyin
      notify()
      return pinyinFn
    })
    .catch(() => null)
  return pending
}

export function pinyinIsLoaded(): boolean {
  return pinyinFn !== null
}

function subscribe(listener: () => void): () => void {
  subscribers.add(listener)
  preloadPinyin()
  return () => subscribers.delete(listener)
}

/**
 * Re-render once the dictionary arrives. Called by the components that memoise a filtered list on
 * the query alone, so a search typed in the first instants of a session is not left permanently
 * showing the answer from before the dictionary landed.
 */
export function usePinyinVersion(): number {
  return useSyncExternalStore(subscribe, () => version, () => 0)
}

export interface PinyinKeys {
  /** Every character's first letter, concatenated: a label read `quan xuan` gives `qx`. */
  initials: string
  /** Every character's full reading, concatenated: the same label gives `quanxuan`. */
  full: string
}

const keyCache = new Map<string, PinyinKeys | null>()
let keyCacheChars = 0

function readings(text: string, pattern: 'first' | 'none'): string {
  const fn = pinyinFn
  if (!fn) return ''
  const parts = fn(text, { pattern: pattern === 'first' ? 'first' : undefined, toneType: 'none', type: 'array' })
  return parts.join('').toLowerCase().replace(/[^a-z0-9]/g, '')
}

/**
 * The pinyin keys of a label, or null when there is nothing to derive: the dictionary is not here
 * yet, the text is a whole note body, or it holds no CJK character at all. Memoised because every
 * listing asks for these once per row per keystroke.
 */
export function pinyinKeysOf(text: string): PinyinKeys | null {
  if (!pinyinFn) return null
  if (text.length > PINYIN_TEXT_LIMIT) return null
  if (!HAN.test(text)) return null
  const cached = keyCache.get(text)
  if (cached !== undefined) return cached
  const keys: PinyinKeys | null = { initials: readings(text, 'first'), full: readings(text, 'none') }
  const result = keys!.initials || keys!.full ? keys : null
  keyCache.set(text, result)
  keyCacheChars += text.length
  if (keyCacheChars > KEY_CACHE_BUDGET) {
    keyCache.clear()
    keyCacheChars = text.length
  }
  return result
}
