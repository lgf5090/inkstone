import { expect, it } from 'vitest'
import { loginSuccessClearTargets } from '../src/worker/routes/auth'

it('clears only identity-scoped keys after a successful login', () => {
  const cleared = loginSuccessClearTargets('alice', '203.0.113.7')
  expect(cleared).toContain('login:203.0.113.7:alice')
  expect(cleared).toContain('login-account:alice')
  expect(cleared).toContain('login-work:203.0.113.7:alice')
  for (const key of cleared) {
    expect(key.startsWith('login-ip:')).toBe(false)
    expect(key.startsWith('login-work-ip:')).toBe(false)
  }
})

it('keeps the invalid-username identity bucket out of shared IP buckets', () => {
  const cleared = loginSuccessClearTargets('!!!', '203.0.113.7')
  expect(cleared).toContain('login:203.0.113.7:_invalid')
  expect(cleared.every((key) => !key.startsWith('login-ip:') && !key.startsWith('login-work-ip:'))).toBe(true)
})
