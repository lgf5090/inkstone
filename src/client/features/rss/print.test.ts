/**
 * The print button's own contract, in the only environment that can see it.
 *
 * What the sheet looks like is a browser question and is answered by measuring one (the probe reads
 * computed styles under print media). What is answered here is the part that is state: the class goes
 * on before `print()` is called, a second press while the dialogue is open does nothing, and the
 * class comes off again — including in a browser that never fires `afterprint`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { printArticle } from './print'

let calls = 0

beforeEach(() => {
  calls = 0
  document.documentElement.className = ''
  vi.stubGlobal('print', () => { calls++ })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

const printing = (): boolean => document.documentElement.classList.contains('rss-printing')

describe('printArticle', () => {
  it('marks the document and asks the browser once', () => {
    printArticle()
    expect(printing()).toBe(true)
    expect(calls).toBe(1)
  })

  it('ignores a second press while the dialogue is open', () => {
    printArticle()
    printArticle()
    expect(calls).toBe(1)
  })

  it('clears the mark when the browser says printing is over', () => {
    printArticle()
    window.dispatchEvent(new Event('afterprint'))
    expect(printing()).toBe(false)
  })

  it('clears the mark anyway for a browser that never says so', () => {
    vi.useFakeTimers()
    printArticle()
    expect(printing()).toBe(true)
    vi.advanceTimersByTime(2000)
    expect(printing()).toBe(false)
  })
})
