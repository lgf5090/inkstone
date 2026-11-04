import { webcrypto } from 'node:crypto'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { NoteLockSession, isNoteLockEnvelope } from '@shared/crypto'
import { MEMO_CIPHER_PREFIX } from '@shared/memos/constants'
import { openMemoBody } from './memo-lock'

beforeAll(() => {
  vi.stubGlobal('crypto', webcrypto)
})

async function sealMemo(passphrase: string, plaintext: string): Promise<string> {
  return (await NoteLockSession.create(passphrase)).seal(plaintext)
}

/** A body sealed by the deleted `memo-crypto.ts`, kept as literal bytes to prove old rows still open. */
const LEGACY_CIPHER = 'memoenc:v1:BwcHBwcHBwcHBwcHBwcHBw:CQkJCQkJCQkJCQkJ:OZsWW-kdCGCP_9zpRJJ2bjxxNv-L7XDOyyfVfHFd-JL-OfNKRfDm_qWO0q_r_qTo737VbGvRlw'
const LEGACY_PLAINTEXT = '# 旧密文\n\nmemoenc:v1 兼容回归。'

describe('sealed memo bodies', () => {
  it('opens exactly what the shared module sealed', async () => {
    const plaintext = '# 标题\n\n一份不离开浏览器的正文。'
    const sealed = await sealMemo('correct horse battery staple', plaintext)
    expect(sealed.startsWith(MEMO_CIPHER_PREFIX)).toBe(true)
    expect(isNoteLockEnvelope(sealed)).toBe(true)
    expect(await openMemoBody('correct horse battery staple', sealed)).toBe(plaintext)
  })

  it('uses a fresh salt and nonce for every seal', async () => {
    const first = await sealMemo('same passphrase', 'same body')
    const second = await sealMemo('same passphrase', 'same body')
    expect(first).not.toBe(second)
    expect(await openMemoBody('same passphrase', first)).toBe('same body')
    expect(await openMemoBody('same passphrase', second)).toBe('same body')
  })

  it('refuses the wrong passphrase instead of returning garbage', async () => {
    const sealed = await sealMemo('right', 'private body')
    await expect(openMemoBody('wrong', sealed)).rejects.toThrow('The passphrase did not open this memo')
  })

  it('refuses a tampered ciphertext', async () => {
    const sealed = await sealMemo('right', 'private body')
    const parts = sealed.split(':')
    const data = parts[4] ?? ''
    parts[4] = `${data[0] === 'A' ? 'B' : 'A'}${data.slice(1)}`
    const tampered = parts.join(':')
    await expect(openMemoBody('right', tampered)).rejects.toThrow('The passphrase did not open this memo')
  })

  it('refuses a value that is not an envelope', async () => {
    await expect(openMemoBody('right', 'not-a-seal')).rejects.toThrow('does not carry a readable sealed body')
  })

  it('opens a ciphertext written by the deleted memo-crypto module', async () => {
    expect(isNoteLockEnvelope(LEGACY_CIPHER)).toBe(true)
    expect(await openMemoBody('legacy memo pass', LEGACY_CIPHER)).toBe(LEGACY_PLAINTEXT)
  })
})
