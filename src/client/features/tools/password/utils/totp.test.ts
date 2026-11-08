import { describe, expect, it } from 'vitest'
import {
  decodeBase32,
  normalizeTotpSecret,
  parseTotpConfig,
  totpCode,
  totpSecondsRemaining,
} from './totp'

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

  it('keeps eight digits, a custom period and a stronger algorithm', () => {
    const stored = normalizeTotpSecret(
      `otpauth://totp/Acme:me?secret=${RFC_SECRET}&digits=8&period=60&algorithm=SHA256`,
    )
    const parsed = parseTotpConfig(stored)
    expect(parsed).toEqual({
      secret: RFC_SECRET,
      digits: 8,
      period: 60,
      algorithm: 'SHA256',
    })
    expect(parseTotpConfig(stored)!.algorithm).toBe('SHA256')
  })
})

describe('parseTotpConfig', () => {
  it('defaults to six digits, thirty seconds and SHA-1 for a bare secret', () => {
    expect(parseTotpConfig(RFC_SECRET)).toEqual({
      secret: RFC_SECRET,
      digits: 6,
      period: 30,
      algorithm: 'SHA1',
    })
    expect(parseTotpConfig('not base32!')).toBeNull()
  })

  it('ignores a digit count or period outside the RFC range', () => {
    const stored = normalizeTotpSecret(
      `otpauth://totp/x?secret=${RFC_SECRET}&digits=99&period=0`,
    )
    expect(stored).toBe(RFC_SECRET)
  })
})

describe('totpCode with provider parameters', () => {
  // The RFC's eight-digit vectors use a longer seed per algorithm; these are the same RFC 6238
  // construction applied to the twenty-byte seed above, at T = 59.
  it('matches SHA-256 when the URI asks for it', () => {
    const uri = `otpauth://totp/x?secret=${RFC_SECRET}&digits=8&algorithm=SHA256`
    expect(totpCode(uri, 59_000)).toBe('32247374')
    expect(totpCode(uri, 59_000)).not.toBe(totpCode(RFC_SECRET, 59_000))
  })

  it('matches SHA-512 when the URI asks for it', () => {
    const uri = `otpauth://totp/x?secret=${RFC_SECRET}&digits=8&algorithm=SHA512`
    expect(totpCode(uri, 59_000)).toBe('69342147')
  })

  it('takes the time step from the period instead of assuming thirty seconds', () => {
    const uri = `otpauth://totp/x?secret=${RFC_SECRET}&period=60`
    // At T = 59 s a 60-second step still sits in counter 0, so the code equals the one a 30-second
    // step produces at the start of its own first window.
    expect(totpCode(uri, 59_000)).toBe(totpCode(RFC_SECRET, 0))
    expect(totpCode(uri, 59_000)).not.toBe(totpCode(RFC_SECRET, 59_000))
    expect(totpSecondsRemaining(59_000, parseTotpConfig(uri)!.period)).toBe(1)
  })
})

describe('totpSecondsRemaining', () => {
  it('counts down to the period boundary', () => {
    expect(totpSecondsRemaining(0)).toBe(30)
    expect(totpSecondsRemaining(29_000)).toBe(1)
    expect(totpSecondsRemaining(30_000)).toBe(30)
  })
})
