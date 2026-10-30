// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'

describe('the Xget category palette', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.resetModules()
  })

  it('computes the palette once per theme and accent', async () => {
    vi.resetModules()
    const spy = vi.spyOn(window, 'getComputedStyle')
    const { categoryColor } = await import('../src/client/features/development/xget/lib/category')

    const first = categoryColor('code', false)
    const calls = spy.mock.calls.length
    expect(calls).toBeGreaterThan(0)

    const second = categoryColor('package', false)
    expect(second).not.toBe(first)
    expect(spy.mock.calls.length).toBe(calls)
  })
})
