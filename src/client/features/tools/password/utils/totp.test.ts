import { describe, expect, it } from 'vitest'
import { decodeBase32, normalizeTotpSecret, totpCode, totpSecondsRemaining } from './totp'

// RFC 6238 Appendix B: the SHA-1 seed is ASCII "12345678901234567890".
const RFC_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'

describe('decodeBase32', () => {
  it('reads the RFC vector back to the ASCII seed', () => {
    expect(new TextDecoder().decode(decodeBase32(RFC_SECRET)!)).toBe('12345678901234567890')
  })

  it('accepts grouping spaces, dashes and padding', () => {
    expect(decodeBase32('GEZD GNBV-GY3T QOJQ GEZD GNBV GY3T QOJQ====')?.length).toBe(20)
  })

  it('refuses characters outside the alphabet', () => {
    expect(decodeBase32('GEZD1NBV')).toBeNull()
    expect(decodeBase32('')).toBeNull()
  })
})

describe('totpCode', () => {
  // RFC 6238 vectors. The published values are eight digits; six-digit codes take the same
  // truncated integer modulo 10^6, which keeps the last six decimals rather than the first six.
  it.each([
    [59_000, '287082'],
    [1_111_111_109_000, '081804'],
    [20_000_000_000_000, '353130'],
  ])('matches the RFC vector at %d ms', (now, expected) => {
    expect(totpCode(RFC_SECRET, now)).toBe(expected)
  })

  it('changes once per period and stays stable inside one', () => {
    const start = 60_000 // counter 2, with the boundary 30 s away
    expect(totpCode(RFC_SECRET, start)).toBe(totpCode(RFC_SECRET, start + 29_999))
    expect(totpCode(RFC_SECRET, start + 30_000)).not.toBe(totpCode(RFC_SECRET, start))
  })

  it('returns null for a secret that is not base32', () => {
    // '0' and '1' are outside the RFC 4648 alphabet; letters alone are valid base32.
    expect(totpCode('notasecret1', 59_000)).toBeNull()
    expect(totpCode('not@secret', 59_000)).toBeNull()
  })

  it('never returns a code shorter than the digit count', () => {
    for (let step = 0; step < 40; step += 1) {
      expect(totpCode(RFC_SECRET, step * 30_000)).toHaveLength(6)
    }
  })
})

describe('normalizeTotpSecret', () => {
  it('accepts the bare secret, grouped and lower case', () => {
    expect(normalizeTotpSecret('gezd gnbv gy3t qojq gezd gnbv gy3t qojq')).toBe(RFC_SECRET)
  })

  it('pulls the secret out of an otpauth URI', () => {
    expect(
      normalizeTotpSecret(
        'otpauth://totp/GitHub:me?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&issuer=GitHub',
      ),
    ).toBe(RFC_SECRET)
  })

  it('refuses garbage instead of storing it', () => {
    expect(normalizeTotpSecret('hello world!')).toBe('')
    expect(normalizeTotpSecret('')).toBe('')
  })
})

describe('totpSecondsRemaining', () => {
  it('counts down to the period boundary', () => {
    expect(totpSecondsRemaining(0)).toBe(30)
    expect(totpSecondsRemaining(29_000)).toBe(1)
    expect(totpSecondsRemaining(30_000)).toBe(30)
  })
})
