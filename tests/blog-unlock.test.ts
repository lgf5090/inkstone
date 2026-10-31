/// <reference types="node" />
import { describe, expect, it } from 'vitest'
import { issueUnlockToken, unlockSecret, verifyUnlockToken } from '../src/worker/blog/unlock'
import { testBindings, testD1 } from './doubles/bindings'

const secret = 'test-unlock-secret-0123456789'
const env = testBindings(testD1(), { BLOG_UNLOCK_SECRET: secret })

describe('protected post unlock tokens', () => {
  it('round-trips a token for its own post', async () => {
    const token = await issueUnlockToken(env, 'post-1', 1_000)
    expect(token).toBeTruthy()
    await expect(verifyUnlockToken(env, 'post-1', token, 1_001)).resolves.toBe(true)
  })

  it('refuses a token issued for another post', async () => {
    const token = await issueUnlockToken(env, 'post-1', 1_000)
    await expect(verifyUnlockToken(env, 'post-2', token, 1_001)).resolves.toBe(false)
  })

  it('refuses an expired token', async () => {
    const token = await issueUnlockToken(env, 'post-1', 1_000)
    await expect(verifyUnlockToken(env, 'post-1', token, 1_000 + 7 * 24 * 60 * 60 * 1000 + 1)).resolves.toBe(false)
  })

  it('refuses a payload changed after signing', async () => {
    const token = await issueUnlockToken(env, 'post-1', 1_000)
    const [payload, signature] = token!.split('.')
    const tampered = `${payload}x.${signature}`
    await expect(verifyUnlockToken(env, 'post-1', tampered, 1_001)).resolves.toBe(false)
  })

  it('issues nothing when the deployment has no secret', async () => {
    const unconfigured = testBindings(testD1())
    expect(unlockSecret(unconfigured)).toBeNull()
    await expect(issueUnlockToken(unconfigured, 'post-1')).resolves.toBeNull()
    await expect(verifyUnlockToken(unconfigured, 'post-1', 'a.b')).resolves.toBe(false)
  })
})
