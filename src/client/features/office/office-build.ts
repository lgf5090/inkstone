/**
 * The package set the next editor mount registers.
 *
 * Registration happens synchronously inside `mountOfficeEditor`, before any React state can reach it,
 * so the reader's choice is mirrored here when their settings load or change. `officeLicense()` falls
 * back to the deployment's own `VITE_UNIVER_LICENSE`, which is what an instance-wide licence uses.
 */
import type { Plugin, PluginCtor, Univer } from '@univerjs/core'
import type { OfficeBuild } from './office-prefs'

let current: OfficeBuild = 'full'
let license = ''
let autosaveDelayMs = 1200

export function setOfficeBuild(build: OfficeBuild, nextLicense: string, nextDelayMs: number): void {
  current = build
  license = nextLicense
  autosaveDelayMs = nextDelayMs
}

export function officeAutosaveDelay(): number {
  return autosaveDelayMs
}

export function officeBuild(): OfficeBuild {
  return current
}

export function officeLicense(): string {
  return license.trim() || String(import.meta.env.VITE_UNIVER_LICENSE ?? '')
}

/** True when Pro packages should register: the full build, licensed or not. */
export function officeUsesProPackages(): boolean {
  return current === 'full'
}

/**
 * Registers a Pro plugin only in the full build.
 *
 * The lite build exists for readers who would rather have the open-source editors without the Pro
 * watermark than the Pro features; every `@univerjs-pro` registration goes through here so the two
 * sets cannot drift apart.
 */
export function registerPro(univer: Univer, plugin: PluginCtor<Plugin>): void {
  if (current !== 'full') return
  univer.registerPlugin(plugin)
}
