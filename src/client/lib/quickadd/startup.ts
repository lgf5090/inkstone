/**
 * The startup macros: the runs the notebook makes on its own.
 *
 * The reference flags each macro `runOnStartup` and fires every flagged one when the vault opens,
 * with no memory of having done so. In a web app "when the vault opens" is "every refresh", so a
 * macro that files a note would leave one per reload; the day scope remembers the last run per macro
 * in this browser, and the session scope keeps the reference's behaviour for anyone who wants it.
 */
import type { QuickAddChoice, QuickAddMacroChoice, QuickAddSettings } from '@shared/quickadd'

export const STARTUP_STAMP_KEY = 'inkstone.quickadd-startup.v1'

export type StartupSettings = Pick<QuickAddSettings, 'enabled' | 'startupScope'>

type StartupStamps = Record<string, string>

type StartupStorage = Pick<Storage, 'getItem' | 'setItem'> | null

const sessionRuns = new Set<string>()

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

/** Every macro the reader asked to run by itself, in the order the launcher lists them. */
export function startupMacros(choices: readonly QuickAddChoice[]): QuickAddMacroChoice[] {
  return choices
    .filter((choice): choice is QuickAddMacroChoice => choice.type === 'macro' && choice.enabled && choice.runOnStartup)
    .sort((a, b) => a.position - b.position)
}

export function loadStartupStamps(storage: StartupStorage = defaultStorage()): StartupStamps {
  try {
    const raw = storage?.getItem(STARTUP_STAMP_KEY)
    if (!raw) return {}
    const value = JSON.parse(raw) as Record<string, unknown>
    const stamps: StartupStamps = {}
    for (const [key, day] of Object.entries(value)) {
      if (typeof day === 'string' && key !== '__proto__') stamps[key] = day
    }
    return stamps
  }
  catch {
    return {}
  }
}

export function saveStartupStamps(stamps: StartupStamps, storage: StartupStorage = defaultStorage()): void {
  try {
    storage?.setItem(STARTUP_STAMP_KEY, JSON.stringify(stamps))
  }
  catch {
    // A private-mode write can throw; the session set still keeps this load quiet.
  }
}

export function shouldRunStartup(
  settings: StartupSettings,
  macroId: string,
  owner: string,
  now: Date = new Date(),
  storage: StartupStorage = defaultStorage(),
): boolean {
  if (!settings.enabled || !macroId || owner === '') return false
  // Never twice in one load, whatever the scope says: the library changes identity a few times while
  // the shell settles, and a browser that refuses to store anything has no day left to check.
  if (sessionRuns.has(ownerKey(owner, macroId))) return false
  if (settings.startupScope === 'session') return true
  return loadStartupStamps(storage)[macroId] !== startupDay(now)
}

export function markStartupRun(
  owner: string,
  macroId: string,
  now: Date = new Date(),
  storage: StartupStorage = defaultStorage(),
): void {
  sessionRuns.add(ownerKey(owner, macroId))
  const stamps = loadStartupStamps(storage)
  stamps[macroId] = startupDay(now)
  saveStartupStamps(stamps, storage)
}

/** Only a test or an account switch needs this; a page load starts with nothing run. */
export function resetStartupSession(): void {
  sessionRuns.clear()
}
