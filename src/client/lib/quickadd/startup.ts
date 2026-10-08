/**
 * The startup macro: the one run the notebook makes on its own.
 *
 * The reference fires every time the vault loads, which in a web app means every refresh — a macro
 * that files a note would leave one per reload. So the default scope remembers the last run per
 * calendar day in this browser, and the session scope keeps the reference's behaviour for anyone who
 * wants exactly that.
 */
import type { QuickAddSettings } from '@shared/quickadd'

export const STARTUP_STAMP_KEY = 'inkstone.quickadd-startup.v1'

export type StartupSettings = Pick<QuickAddSettings, 'enabled' | 'startupMacroId' | 'startupScope'>

interface StartupStamp {
  macroId: string
  day: string
}

type StartupStorage = Pick<Storage, 'getItem' | 'setItem'> | null

let sessionRun: string | null = null

function defaultStorage(): StartupStorage {
  return typeof localStorage === 'undefined' ? null : localStorage
}

function ownerKey(owner: string, macroId: string): string {
  return `${owner}\u001F${macroId}`
}

/** The reader's own calendar day, not the UTC one: "once a day" means their day. */
export function startupDay(now: Date): string {
  const pad = (part: number): string => String(part).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

export function loadStartupStamp(storage: StartupStorage = defaultStorage()): StartupStamp | null {
  try {
    const raw = storage?.getItem(STARTUP_STAMP_KEY)
    if (!raw) return null
    const value = JSON.parse(raw) as { macroId?: unknown; day?: unknown }
    if (typeof value.macroId !== 'string' || typeof value.day !== 'string') return null
    return { macroId: value.macroId, day: value.day }
  }
  catch {
    return null
  }
}

export function saveStartupStamp(stamp: StartupStamp, storage: StartupStorage = defaultStorage()): void {
  try {
    storage?.setItem(STARTUP_STAMP_KEY, JSON.stringify(stamp))
  }
  catch {
    // A private-mode write can throw; the session flag still keeps this load quiet.
  }
}

export function shouldRunStartup(
  settings: StartupSettings,
  owner: string,
  now: Date = new Date(),
  storage: StartupStorage = defaultStorage(),
): boolean {
  const macroId = settings.startupMacroId
  if (!settings.enabled || !macroId || owner === '') return false
  // Never twice in one load, whatever the scope says: the library can change identity a few times
  // while the shell settles, and a browser that refuses to store anything has no day to check.
  if (sessionRun === ownerKey(owner, macroId)) return false
  if (settings.startupScope === 'session') return true
  const stamp = loadStartupStamp(storage)
  return stamp === null || stamp.macroId !== macroId || stamp.day !== startupDay(now)
}

export function markStartupRun(
  owner: string,
  macroId: string,
  now: Date = new Date(),
  storage: StartupStorage = defaultStorage(),
): void {
  sessionRun = ownerKey(owner, macroId)
  saveStartupStamp({ macroId, day: startupDay(now) }, storage)
}

/** Only a test or an account switch needs this; a page load starts with nothing run. */
export function resetStartupSession(): void {
  sessionRun = null
}
