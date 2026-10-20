import { describe, expect, it } from 'vitest'
import { EN_US_MESSAGES } from '@shared/locales/en-US'
import { ZH_CN_MESSAGES } from '@shared/locales/zh-CN'
import { HOST_METHODS, HOST_METHOD_CAPABILITY, type Capabilities } from './protocol'
import { TEMPLATER_ERROR_CODES, TEMPLATER_ERROR_MESSAGES, TemplaterError, isTemplaterErrorCode, templaterErrorCode, templaterErrorDetail } from './errors'

// The catalogs are typed to include note-template content keys, which live in a separate lazily-loaded
// resource; this table only ever names UI labels, so it reads them as the flat string maps they are.
const en = EN_US_MESSAGES as unknown as Record<string, string>
const zh = ZH_CN_MESSAGES as unknown as Record<string, string>

const CAPABILITY_KEYS = Object.keys({
  writeActiveNote: true,
  createNotes: true,
  moveNotes: true,
  readOtherNotes: true,
  prompt: true,
  web: true,
  userScripts: true,
  clipboard: true,
} as Capabilities)

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
