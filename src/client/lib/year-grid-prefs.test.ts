import { describe, expect, it, vi } from 'vitest'
import { STORAGE_KEY, cycleYearGridColumns, setYearGridColumns, useYearGridColumns } from './year-grid-prefs'
import { act, createElement } from 'react'
import { renderElement } from './test-render'

describe('year-grid-columns preference', () => {
  it('defaults to auto and persists a fixed choice as a JSON string', () => {
    localStorage.clear()
    let value: string | null = null
    function Probe() {
      value = useYearGridColumns()
      return null
    }
    const { unmount } = renderElement(createElement(Probe))
    expect(value).toBe('auto')
    act(() => { setYearGridColumns('3'); })
    expect(value).toBe('3')
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null')).toBe('3')
    unmount()
  })

  it('cycles auto -> 3 -> 4 -> auto', () => {
    expect(cycleYearGridColumns('auto')).toBe('3')
    expect(cycleYearGridColumns('3')).toBe('4')
    expect(cycleYearGridColumns('4')).toBe('auto')
  })

  it('recovers both quoted and legacy unquoted numeric values on load', async () => {
    const read = async (raw: string): Promise<string | null> => {
      localStorage.setItem(STORAGE_KEY, raw)
      vi.resetModules()
      const mod = await import('./year-grid-prefs')
      const store = mod.useYearGridColumns
      localStorage.removeItem(STORAGE_KEY)
      let value: string | null = null
      function Probe() {
        value = store()
        return null
      }
      const { unmount } = renderElement(createElement(Probe))
      unmount()
      return value
    }
    expect(await read(JSON.stringify('4'))).toBe('4')
    expect(await read('3')).toBe('3')
  })
})