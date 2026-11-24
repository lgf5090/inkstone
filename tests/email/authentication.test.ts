import { describe, expect, it } from 'vitest'
import { emailAuthenticationStatus } from '../../src/shared/email/authentication'

describe('email authentication results', () => {
  it('reads SPF, DKIM and DMARC from folded provider headers', () => {
    expect(emailAuthenticationStatus([
      { key: 'Authentication-Results', value: 'mx.example; spf=pass smtp.mailfrom=example.com; dkim=pass header.d=example.com' },
      { key: 'authentication-results', value: 'dmarc=fail header.from=example.com' },
    ])).toEqual({ spf: 'pass', dkim: 'pass', dmarc: 'fail' })
  })

  it('returns no status when the provider did not authenticate the message', () => {
    expect(emailAuthenticationStatus([{ key: 'Subject', value: 'Hello' }])).toEqual({})
  })
})
