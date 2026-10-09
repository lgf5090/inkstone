/**
 * The startup macros: the runs the notebook makes on its own.
 *
 * The reference flags each macro `runOnStartup` and fires every flagged one when the vault opens,
 * with no memory of having done so. In a web app "when the vault opens" is "every refresh", so a
 * macro that files a note would leave one per reload; the day scope remembers the last run per account
 * and macro in this browser, and the session scope keeps the reference's behaviour for anyone who
 * wants it.
 */
import type { QuickAddChoice, QuickAddMacroChoice, QuickAddSettings } from '@shared/quickadd'

export const STARTUP_STAMP_KEY = 'inkstone.quickadd-startup.v1'

/** The byte no account id or macro id can carry, which is what makes a stamp key readable. */
const STAMP_SEPARATOR = '\u001F'

export type StartupSettings = Pick<QuickAddSettings, 'enabled' | 'startupScope'>

type StartupStamps = Record<string, string>

type StartupStorage = Pick<Storage, 'getItem' | 'setItem'> | null

const sessionRuns = new Set<string>()

function defaultStorage(): StartupStorage {
  return typeof localStorage === 'undefined' ? null : localStorage
}

function ownerKey(owner: string, macroId: string): string {
  return `${owner}${STAMP_SEPARATOR}${macroId}`
}

/**
 * A stamp is only ever read back through `ownerKey`, so a key without the separator — what this file
 * wrote before the day half learned about accounts — can never be looked at again. It is dropped on
 * the way in, and the write below drops the days that have passed.
 */
function isOwnerKey(key: string): boolean {
  return key.includes(STAMP_SEPARATOR)
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
      if (typeof day === 'string' && key !== '__proto__' && isOwnerKey(key)) stamps[key] = day
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
  return loadStartupStamps(storage)[ownerKey(owner, macroId)] !== startupDay(now)
}

export function markStartupRun(
  owner: string,
  macroId: string,
  now: Date = new Date(),
  storage: StartupStorage = defaultStorage(),
): void {
  sessionRuns.add(ownerKey(owner, macroId))
  const day = startupDay(now)
  const kept: StartupStamps = {}
  // A stamp from an earlier day can never suppress a run, so keeping it would only grow the file.
  for (const [key, stamp] of Object.entries(loadStartupStamps(storage))) {
    if (stamp === day) kept[key] = stamp
  }
  kept[ownerKey(owner, macroId)] = day
  saveStartupStamps(kept, storage)
}

/** Only a test or an account switch needs this; a page load starts with nothing run. */
export function resetStartupSession(): void {
  sessionRuns.clear()
}
