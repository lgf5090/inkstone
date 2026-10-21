// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { MEMO_PAT_PREFIX } from '../src/shared/memos/constants'
import { canReadMemo, isProtectedReadable, isPubliclyReadable } from '../src/worker/memos/access'
import {
  constantTimeEqual,
  createOpaqueToken,
  createShareToken,
  hashOpaqueToken,
  tokenPrefix,
} from '../src/worker/memos/tokens'

const PAT_SHAPE = /^memo_pat_[A-Za-z0-9_-]{43}$/
const SHARE_TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/
const SHA256_HEX_SHAPE = /^[a-f0-9]{64}$/
const OWNER_ID = 'user-owner'
const OTHER_ID = 'user-other'

describe('opaque tokens', () => {
  it('mints a PAT from the fixed prefix and 32 random bytes', () => {
    const token = createOpaqueToken(MEMO_PAT_PREFIX)
    expect(token).toMatch(PAT_SHAPE)
    expect(token).toHaveLength(MEMO_PAT_PREFIX.length + 43)
    expect(token.startsWith(MEMO_PAT_PREFIX)).toBe(true)
  })

  it('mints a different PAT on every call', () => {
    const tokens = Array.from({ length: 32 }, () => createOpaqueToken(MEMO_PAT_PREFIX))
    expect(new Set(tokens).size).toBe(tokens.length)
  })

  it('sizes the opaque part from the requested byte count', () => {
    expect(createOpaqueToken('custom_', 16)).toMatch(/^custom_[A-Za-z0-9_-]{22}$/)
    expect(createOpaqueToken('custom_', 24)).toMatch(/^custom_[A-Za-z0-9_-]{32}$/)
  })

  it('hashes a token the same way every time', async () => {
    const token = createOpaqueToken(MEMO_PAT_PREFIX)
    const first = await hashOpaqueToken(token)
    const second = await hashOpaqueToken(token)
    expect(first).toBe(second)
    expect(first).toMatch(SHA256_HEX_SHAPE)
    expect(first).not.toBe(token)
    expect(first).not.toContain(token)
  })

  it('hashes with SHA-256', async () => {
    await expect(hashOpaqueToken('abc')).resolves.toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    )
  })

  it('keeps only a fixed leading slice as the stored display prefix', () => {
    const token = createOpaqueToken(MEMO_PAT_PREFIX)
    const prefix = tokenPrefix(token)
    expect(prefix).toBe(token.slice(0, 16))
    expect(prefix).toHaveLength(16)
    expect(prefix.startsWith(MEMO_PAT_PREFIX)).toBe(true)
    expect(prefix).not.toBe(token)
  })
})

describe('share tokens', () => {
  it('mints a URL-safe 32-byte token with its hash', async () => {
    const share = await createShareToken()
    expect(share.token).toMatch(SHARE_TOKEN_SHAPE)
    expect(share.token).toHaveLength(43)
    expect(share.hash).toMatch(SHA256_HEX_SHAPE)
    expect(share.hash).toBe(await hashOpaqueToken(share.token))
  })

  it('never repeats a token', async () => {
    const shares = await Promise.all(Array.from({ length: 32 }, () => createShareToken()))
    expect(new Set(shares.map((share) => share.token)).size).toBe(shares.length)
  })
})

describe('constant-time comparison', () => {
  it('accepts identical strings', () => {
    expect(constantTimeEqual('memo_pat_abc123', 'memo_pat_abc123')).toBe(true)
    expect(constantTimeEqual('', '')).toBe(true)
  })

  it('rejects strings of the same length that differ', () => {
    expect(constantTimeEqual('memo_pat_abc123', 'memo_pat_abc124')).toBe(false)
    expect(constantTimeEqual('abc', 'abd')).toBe(false)
  })

  it('rejects strings of different lengths', () => {
    expect(constantTimeEqual('memo_pat_abc123', 'memo_pat_abc1234')).toBe(false)
    expect(constantTimeEqual('', 'memo_pat_abc123')).toBe(false)
  })
})

describe('readability helpers', () => {
  it('allows only normal public memos through the public gate', () => {
    expect(isPubliclyReadable('public', 'normal')).toBe(true)
    expect(isPubliclyReadable('public', 'archived')).toBe(false)
    expect(isPubliclyReadable('protected', 'normal')).toBe(false)
    expect(isPubliclyReadable('private', 'normal')).toBe(false)
  })

  it('opens protected memos only to signed-in viewers', () => {
    expect(isProtectedReadable(OTHER_ID, 'protected', 'normal')).toBe(true)
    expect(isProtectedReadable(null, 'protected', 'normal')).toBe(false)
    expect(isProtectedReadable(OTHER_ID, 'protected', 'archived')).toBe(false)
    expect(isProtectedReadable(OTHER_ID, 'public', 'normal')).toBe(false)
    expect(isProtectedReadable(OTHER_ID, 'private', 'normal')).toBe(false)
  })
})

const memoAccessCases = [
  { visibility: 'private', state: 'normal', readable: { owner: true, other: false, anonymous: false } },
  { visibility: 'private', state: 'archived', readable: { owner: true, other: false, anonymous: false } },
  { visibility: 'protected', state: 'normal', readable: { owner: true, other: true, anonymous: false } },
  { visibility: 'protected', state: 'archived', readable: { owner: true, other: false, anonymous: false } },
  { visibility: 'public', state: 'normal', readable: { owner: true, other: true, anonymous: true } },
  { visibility: 'public', state: 'archived', readable: { owner: true, other: false, anonymous: false } },
] as const

const memoViewers = [
  ['owner', OWNER_ID],
  ['other', OTHER_ID],
  ['anonymous', null],
] as const

describe('the memo read matrix', () => {
  for (const { visibility, state, readable } of memoAccessCases) {
    for (const [viewer, viewerId] of memoViewers) {
      it(`${viewer} can read a ${visibility} ${state} memo: ${readable[viewer]}`, () => {
        expect(canReadMemo(viewerId, { userId: OWNER_ID, visibility, state })).toBe(readable[viewer])
      })
    }
  }
})
