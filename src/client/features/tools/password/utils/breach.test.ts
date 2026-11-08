import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../api', () => ({
  passwordApi: {
    checkBreach: vi.fn(),
  },
}))

import { passwordApi } from '../api'
import { breachCount, resetBreachCache, sha1Hex } from './breach'

// SHA-1("password") — the canonical HIBP example.
const PASSWORD_HASH = '5BAA61E4C9B93F3F0682250B6CF8331B7EE68FD8'

beforeEach(() => {
  vi.clearAllMocks()
  resetBreachCache()
})

describe('sha1Hex', () => {
  it('matches the known SHA-1 of a password', async () => {
    expect(await sha1Hex('password')).toBe(PASSWORD_HASH)
  })
})

describe('breachCount', () => {
  it('asks only for the five-character prefix and matches the suffix locally', async () => {
    vi.mocked(passwordApi.checkBreach).mockResolvedValue([
      { suffix: PASSWORD_HASH.slice(5), count: 42 },
    ])

    expect(await breachCount('password')).toBe(42)
    expect(passwordApi.checkBreach).toHaveBeenCalledWith('5BAA6')
    // The suffix never leaves the browser: the only argument is the prefix.
    expect(vi.mocked(passwordApi.checkBreach).mock.calls[0]).toEqual(['5BAA6'])
  })

  it('answers zero when the padded range does not contain the suffix', async () => {
    vi.mocked(passwordApi.checkBreach).mockResolvedValue([
      { suffix: '00000000000000000000000000000000000', count: 7 },
    ])
    expect(await breachCount('password')).toBe(0)
  })

  it('reuses one range response for passwords that share a prefix', async () => {
    vi.mocked(passwordApi.checkBreach).mockResolvedValue([
      { suffix: PASSWORD_HASH.slice(5), count: 42 },
    ])

    await breachCount('password')
    await breachCount('password')

    expect(passwordApi.checkBreach).toHaveBeenCalledTimes(1)
  })

  it('lets the caller see a failed lookup instead of reporting "not breached"', async () => {
    vi.mocked(passwordApi.checkBreach).mockRejectedValue(new Error('hibp_unavailable'))
    await expect(breachCount('password')).rejects.toThrow('hibp_unavailable')
  })
})
