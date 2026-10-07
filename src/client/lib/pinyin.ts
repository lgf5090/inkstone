import { useSyncExternalStore } from 'react'

/**
 * Chinese first-letter search.
 *
 * Typing `qx` has to find the menu row for selecting all, and `ysms` the one for presentation mode.
 * That needs a Han-to-reading table, which is a dictionary rather than an algorithm, so it is a lazy
 * chunk: the app boots without it, it is fetched only once something in the session has actually
 * asked for a reading, and every matcher treats an unloaded dictionary as "no pinyin answer" rather
 * than blocking on it.
 *
 * Two consequences, both handled here rather than at the call sites. A search that ran before the
 * chunk landed can have missed, so the module publishes a version and the surfaces that own a search
 * box subscribe to it — see {@link usePinyinVersion}. And deriving readings for a whole vault costs
 * about 0.06ms per label, which is 120ms of one synchronous task across 2000 notes — so
 * {@link warmPinyinKeys} spreads that over idle callbacks instead, and the first keystroke pays
 * nothing.
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

/**
 * Ask for the dictionary because a matcher just met a label it could only answer with a reading.
 * Idempotent, and deliberately not awaited: the answer this keystroke gives is the literal one, and
 * the version bump re-runs the listing once the chunk arrives.
 */
export function requestPinyinForReading(): void {
  void preloadPinyin()
}

function subscribe(listener: () => void): () => void {
  subscribers.add(listener)
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

/** Whether a piece of text is short enough, and Chinese enough, to be worth deriving a reading for. */
export function textNeedsReading(text: string): boolean {
  return text.length <= PINYIN_TEXT_LIMIT && HAN.test(text)
}

/**
 * The pinyin keys of a label, or null when there is nothing to derive: the dictionary is not here
 * yet, the text is a whole note body, or it holds no CJK character at all. Memoised because every
 * listing asks for these once per row per keystroke.
 */
export function pinyinKeysOf(text: string): PinyinKeys | null {
  if (!pinyinFn) {
    // Meeting a Chinese label with no dictionary is the intent signal: ask for the chunk now, and let
    // the version bump re-run the listing when it lands.
    if (textNeedsReading(text)) requestPinyinForReading()
    return null
  }
  if (!textNeedsReading(text)) return null
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

/** Whether a label's reading has already been derived — the warm-up's own progress signal. */
export function pinyinKeysCached(text: string): boolean {
  return keyCache.has(text)
}

/**
 * Derive readings for up to `limit` labels that do not have one yet, starting at `from`, and return
 * the index to continue from. Bounded work in, bounded time out: this is the piece a keystroke would
 * otherwise pay all at once.
 */
export function derivePinyinKeys(texts: readonly string[], from: number, limit: number): number {
  if (!pinyinFn) return from
  let index = from
  let derived = 0
  while (index < texts.length && derived < limit) {
    const text = texts[index]!
    index++
    if (!textNeedsReading(text) || keyCache.has(text)) continue
    pinyinKeysOf(text)
    derived++
  }
  return index
}

function runWhenIdle(task: () => void): number {
  if (typeof window.requestIdleCallback === 'function') return window.requestIdleCallback(task, { timeout: 4_000 })
  return window.setTimeout(task, 200)
}

function cancelIdle(handle: number): void {
  if (typeof window.cancelIdleCallback === 'function') window.cancelIdleCallback(handle)
  else window.clearTimeout(handle)
}

/**
 * Walk a listing's labels deriving their readings, a chunk per idle callback, and return a cancel.
 *
 * A 2000-note vault costs about 120ms of dictionary work — one long task on the first keystroke if
 * nothing spreads it out, invisible if idle does. Labels already cached are stepped over, so a
 * re-warm after the vault changes costs what is new and nothing else.
 */
export function warmPinyinKeys(texts: readonly string[], chunk = 64): () => void {
  let cursor = 0
  let handle = -1
  let stopped = false
  const tick = (): void => {
    if (stopped) return
    if (!pinyinFn) return
    cursor = derivePinyinKeys(texts, cursor, chunk)
    if (cursor < texts.length) handle = runWhenIdle(tick)
  }
  handle = runWhenIdle(tick)
  return () => {
    stopped = true
    if (handle >= 0) cancelIdle(handle)
  }
}
