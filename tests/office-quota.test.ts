// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { OFFICE_LIMITS } from '../src/shared/office/constants'
import { officeBytesExceeded } from '../src/shared/office/quota'

const limit = OFFICE_LIMITS.bytesPerUser

describe('the office storage ceiling', () => {
  it('allows a write that lands exactly on the limit', () => {
    expect(officeBytesExceeded(limit - 1000, 1000)).toBe(false)
  })

  it('refuses the byte past it', () => {
    expect(officeBytesExceeded(limit - 1000, 1001)).toBe(true)
  })

  it('does not count the file being replaced twice', () => {
    // A full account re-saving a file of the same size spends nothing new.
    expect(officeBytesExceeded(limit, 400, 400)).toBe(false)
    expect(officeBytesExceeded(limit, 401, 400)).toBe(true)
  })
})
