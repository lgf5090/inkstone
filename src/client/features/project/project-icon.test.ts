import { afterEach, describe, expect, it } from 'vitest'
import { randomProjectIcon, readRandomIconPref, writeRandomIconPref } from './project-icon'

afterEach(() => { localStorage.clear() })

describe('random icon preference (A-10)', () => {
  it('defaults off and round-trips through localStorage', () => {
    expect(readRandomIconPref()).toBe(false)
    writeRandomIconPref(true)
    expect(readRandomIconPref()).toBe(true)
    writeRandomIconPref(false)
    expect(readRandomIconPref()).toBe(false)
  })

  it('randomProjectIcon returns a non-empty emoji glyph', async () => {
    const icon = await randomProjectIcon()
    expect(icon.length).toBeGreaterThan(0)
  })
})