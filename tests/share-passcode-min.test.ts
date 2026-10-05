import { expect, it } from 'vitest'
import { sharePasscodeProblem } from '../src/shared/share-passcode'

it('accepts an empty passcode (share without password)', () => {
  expect(sharePasscodeProblem(undefined)).toBeNull()
  expect(sharePasscodeProblem('')).toBeNull()
})

it('rejects passcodes shorter than eight characters', () => {
  expect(sharePasscodeProblem('1234567')).not.toBeNull()
  expect(sharePasscodeProblem('1234567')).toMatch(/at least 8/)
})

it('accepts eight or more characters', () => {
  expect(sharePasscodeProblem('12345678')).toBeNull()
  expect(sharePasscodeProblem('a-long-enough-passcode')).toBeNull()
})
