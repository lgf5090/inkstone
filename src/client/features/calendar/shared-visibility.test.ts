import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readHiddenShared, writeHiddenShared } from './shared-visibility'

beforeEach(() => {
  localStorage.clear()
  vi.restoreAllMocks()
})

describe('shared calendar visibility', () => {
  it('keeps each account hidden shared calendars separate', () => {
    writeHiddenShared('alice', new Set(['shared:owner-a:cal']))
    writeHiddenShared('bob', new Set(['shared:owner-b:cal']))
    expect([...readHiddenShared('alice')]).toEqual(['shared:owner-a:cal'])
    expect([...readHiddenShared('bob')]).toEqual(['shared:owner-b:cal'])
  })

  it('shows everything when the stored value is corrupt', () => {
    localStorage.setItem('inkstone.calendar.hidden-shared:alice', '{broken')
    vi.spyOn(console, 'debug').mockImplementation(() => {})
    expect(readHiddenShared('alice').size).toBe(0)
  })

  it('does not break the view when storage refuses a write', () => {
    vi.spyOn(console, 'debug').mockImplementation(() => {})
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota') })
    expect(() => writeHiddenShared('alice', new Set(['shared:owner:cal']))).not.toThrow()
  })
})
