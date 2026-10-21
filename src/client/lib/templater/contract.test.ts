import { describe, expect, it } from 'vitest'
import { EN_US_MESSAGES } from '@shared/locales/en-US'
import { ZH_CN_MESSAGES } from '@shared/locales/zh-CN'
import {
  CAPABILITY_PROFILES,
  capabilitiesFor,
  HOST_METHODS,
  HOST_METHOD_CAPABILITY,
  type CapabilityProfile,
  type Capabilities,
} from './protocol'
import { TEMPLATER_ERROR_CODES, TEMPLATER_ERROR_MESSAGES, TemplaterError, isTemplaterErrorCode, templaterErrorCode, templaterErrorDetail } from './errors'

// The catalogs are typed to include note-template content keys, which live in a separate lazily-loaded
// resource; this table only ever names UI labels, so it reads them as the flat string maps they are.
const en = EN_US_MESSAGES as unknown as Record<string, string>
const zh = ZH_CN_MESSAGES as unknown as Record<string, string>

// The eight rights, read off the shipped table rather than spelled out again here: a test that restates
// the shape cannot notice when the shape and the table part company.
const PROFILE_KEYS: CapabilityProfile[] = ['local', 'community', 'preview', 'dynamic', 'startup']
const CAPABILITY_KEYS = Object.keys(CAPABILITY_PROFILES.local)

describe('templater error codes', () => {
  it('names every code in both locale resources', () => {
    for (const code of TEMPLATER_ERROR_CODES) {
      const key = TEMPLATER_ERROR_MESSAGES[code]
      // A code without a sentence would reach the reader as the token itself.
      expect(en[key], `en-US is missing ${key}`).toBeTruthy()
      // The zh catalog is typed as `Record<BaseMessageKey, string>`, so a missing key would not
      // compile; asserting it anyway keeps the guard honest if that typing is ever loosened.
      expect(zh[key], `zh-CN is missing ${key}`).toBeTruthy()
    }
  })

  it('keeps the locale keys free of English prose in the catalog and vice versa', () => {
    // The i18n gate forbids Han characters in en values; a code name leaking through would be a
    // second failure mode, so the check is on the mapping, not on the catalogs.
    for (const code of TEMPLATER_ERROR_CODES) {
      expect(isTemplaterErrorCode(code)).toBe(true)
      expect(TEMPLATER_ERROR_MESSAGES[code]).toMatch(/^templater\.error\.[a-z0-9_]+$/)
    }
  })

  it('carries a measurement in detail and keeps it separate from the code', () => {
    const error = new TemplaterError('sandbox-timeout', '2000ms')
    expect(error.code).toBe('sandbox-timeout')
    expect(templaterErrorDetail(error)).toBe('2000ms')
    expect(templaterErrorCode(error)).toBe('sandbox-timeout')
    expect(error.message).toBe('sandbox-timeout: 2000ms')
  })

  it('reads a code back from the wire form, where instanceof does not hold', () => {
    // The worker answers with a plain object; trusting `instanceof` across that boundary would turn
    // every real failure into the generic one.
    expect(templaterErrorCode({ code: 'web-blocked' })).toBe('web-blocked')
    expect(templaterErrorCode('capability-blocked')).toBe('capability-blocked')
    expect(templaterErrorCode('capability-blocked: tp.web')).toBe('capability-blocked')
  })

  it('falls back to the generic code rather than inventing one for the unknown', () => {
    expect(templaterErrorCode(new Error('boom'))).toBe('render-failed')
    expect(templaterErrorCode('something else entirely')).toBe('render-failed')
    expect(templaterErrorCode(null)).toBe('render-failed')
    // …and keeps the original text reachable, so a crash does not become a shrug.
    expect(templaterErrorDetail('TypeError: x is not a function')).toBe('TypeError: x is not a function')
  })
})

describe('host method surface', () => {
  it('gates every method the interpreter can name', () => {
    for (const method of HOST_METHODS) {
      const capability = HOST_METHOD_CAPABILITY[method]
      // A method with no gate would be callable by a community template under the narrowest profile.
      expect(capability, `${method} has no capability mapping`).toBeTruthy()
      expect(CAPABILITY_KEYS, `${method} gates on the unknown capability ${capability}`).toContain(capability)
    }
  })

  it('maps no capability that the profile cannot express', () => {
    const mapped = new Set(Object.values(HOST_METHOD_CAPABILITY))
    for (const key of CAPABILITY_KEYS) expect(mapped.has(key as keyof Capabilities), `${key} is unused`).toBe(true)
  })

  it('keeps the two lists the same size, so a new method cannot arrive ungated', () => {
    expect(Object.keys(HOST_METHOD_CAPABILITY).length).toBe(HOST_METHODS.length)
  })
})

describe('capability profiles', () => {
  it('answers every profile with every capability', () => {
    for (const profile of PROFILE_KEYS) {
      expect(Object.keys(CAPABILITY_PROFILES[profile]).sort()).toEqual([...CAPABILITY_KEYS].sort())
    }
  })

  /**
   * The approved matrix, plan §D15, one row per profile.
   *
   * Stated as a table rather than a list of `expect(...)` calls because the row is the decision: when
   * someone widens a profile, the diff shows which column of which surface moved, and a reviewer can
   * check that against the plan without re-deriving the policy from the source. This is also the only
   * place the policy is written twice on purpose — the page's settings screen and the worker's gate read
   * one table, so a second copy of the numbers belongs here and nowhere else in `src`.
   */
  const MATRIX: Record<CapabilityProfile, Capabilities> = {
    local: { writeActiveNote: true, createNotes: true, moveNotes: true, readOtherNotes: true, prompt: true, web: true, userScripts: true, clipboard: true },
    community: { writeActiveNote: false, createNotes: false, moveNotes: false, readOtherNotes: false, prompt: true, web: false, userScripts: false, clipboard: false },
    preview: { writeActiveNote: false, createNotes: false, moveNotes: false, readOtherNotes: false, prompt: true, web: false, userScripts: false, clipboard: false },
    dynamic: { writeActiveNote: false, createNotes: false, moveNotes: false, readOtherNotes: false, prompt: true, web: false, userScripts: false, clipboard: false },
    startup: { writeActiveNote: true, createNotes: true, moveNotes: true, readOtherNotes: true, prompt: false, web: false, userScripts: true, clipboard: false },
  }

  it('matches the approved capability matrix cell for cell', () => {
    for (const profile of PROFILE_KEYS) {
      expect(CAPABILITY_PROFILES[profile], profile).toEqual(MATRIX[profile])
    }
  })

  it('lets the reader own everything and a stranger nothing that leaves the note', () => {
    expect(Object.values(CAPABILITY_PROFILES.local).every(Boolean)).toBe(true)
    // A gallery template used without importing it: it may ask, and it may produce text. Nothing else.
    const granted = Object.entries(CAPABILITY_PROFILES.community).filter(([, on]) => on).map(([name]) => name)
    expect(granted).toEqual(['prompt'])
  })

  it('keeps an unattended run from asking, reaching out or reading the clipboard', () => {
    // Startup templates run with nobody at the keyboard, so a prompt would hang the launch and a network
    // call would be the reader's data leaving on a schedule they did not just press.
    const capabilities = CAPABILITY_PROFILES.startup
    expect(capabilities.prompt).toBe(false)
    expect(capabilities.web).toBe(false)
    expect(capabilities.clipboard).toBe(false)
    expect(capabilities.writeActiveNote).toBe(true)
    expect(capabilities.userScripts).toBe(true)
    // …while the one thing an unattended template is actually asked to do — file today's daily note when
    // the app opens — stays allowed, because the reader put it there.
    expect(capabilities.createNotes).toBe(true)
  })

  it('keeps preview and dynamic passes from writing, going online or reading the rest of the vault', () => {
    for (const profile of ['preview', 'dynamic'] as CapabilityProfile[]) {
      const capabilities = CAPABILITY_PROFILES[profile]
      expect(capabilities.writeActiveNote, profile).toBe(false)
      expect(capabilities.createNotes, profile).toBe(false)
      expect(capabilities.moveNotes, profile).toBe(false)
      expect(capabilities.web, profile).toBe(false)
      expect(capabilities.clipboard, profile).toBe(false)
      expect(capabilities.userScripts, profile).toBe(false)
      expect(capabilities.readOtherNotes, profile).toBe(false)
      // …while still allowing the one visible interaction an author needs when testing their own template.
      expect(capabilities.prompt, profile).toBe(true)
    }
  })

  it('hands out a copy, so a host cannot edit the table', () => {
    const capabilities = capabilitiesFor('preview')
    capabilities.writeActiveNote = true
    expect(CAPABILITY_PROFILES.preview.writeActiveNote).toBe(false)
  })
})
