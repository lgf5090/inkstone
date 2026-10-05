// @vitest-environment node
import { expect, it } from 'vitest'
import { loginThrottleTargets } from '../src/worker/routes/auth'

it('caps a real account globally, but not every mistyped name together', () => {
  const valid = loginThrottleTargets('alice', '203.0.113.7').map((target) => target.key)
  expect(valid).toContain('login-account:alice')

  // Malformed names all hash to one identity, so an anonymous caller used to be able
  // to lock out anybody who mistyped their username by filling that shared bucket.
  const malformed = loginThrottleTargets('Not A Username', '203.0.113.7').map((target) => target.key)
  expect(malformed).not.toContain('login-account:_invalid')
  expect(malformed).toContain('login:203.0.113.7:_invalid')
  expect(malformed).toContain('login-ip:203.0.113.7')
})
