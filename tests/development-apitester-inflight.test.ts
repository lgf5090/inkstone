// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  beginRequest,
  cancelRequest,
  endRequest,
} from '../src/client/features/development/api-tester/lib/inflight'

describe('API Tester in-flight request registry', () => {
  it('aborts only the same tab when a new request starts there', () => {
    const first = beginRequest('tab-a-1')
    const other = beginRequest('tab-b-1')
    const second = beginRequest('tab-a-1')

    expect(first.signal.aborted).toBe(true)
    expect(other.signal.aborted).toBe(false)
    expect(second.signal.aborted).toBe(false)
    endRequest('tab-a-1', second)
    endRequest('tab-b-1', other)
  })

  it('cancels exactly the requested tab', () => {
    const a = beginRequest('tab-a-2')
    const b = beginRequest('tab-b-2')

    cancelRequest('tab-a-2')

    expect(a.signal.aborted).toBe(true)
    expect(b.signal.aborted).toBe(false)
    endRequest('tab-a-2', a)
    endRequest('tab-b-2', b)
  })

  it('does not unregister a controller that a newer request replaced', () => {
    const stale = beginRequest('tab-a-3')
    const current = beginRequest('tab-a-3')

    endRequest('tab-a-3', stale)
    cancelRequest('tab-a-3')

    expect(current.signal.aborted).toBe(true)
    endRequest('tab-a-3', current)
  })
})
