import { webcrypto } from 'node:crypto'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { MEMO_CIPHER_PREFIX } from '@shared/memos/constants'
import { decryptMemoContent, encryptMemoContent, looksLikeMemoCipher } from './memo-crypto'

beforeAll(() => {
  vi.stubGlobal('crypto', webcrypto)
})

describe('sealed memo bodies', () => {
  it('opens exactly what it sealed', async () => {
    const plaintext = '# 标题\n\n一份不离开浏览器的正文。'
    const sealed = await encryptMemoContent('correct horse battery staple', plaintext)
    expect(sealed.startsWith(MEMO_CIPHER_PREFIX)).toBe(true)
    expect(looksLikeMemoCipher(sealed)).toBe(true)
    expect(await decryptMemoContent('correct horse battery staple', sealed)).toBe(plaintext)
  })

  it('uses a fresh salt and nonce for every seal', async () => {
    const first = await encryptMemoContent('same passphrase', 'same body')
    const second = await encryptMemoContent('same passphrase', 'same body')
    expect(first).not.toBe(second)
    expect(await decryptMemoContent('same passphrase', first)).toBe('same body')
    expect(await decryptMemoContent('same passphrase', second)).toBe('same body')
  })

  it('refuses the wrong passphrase instead of returning garbage', async () => {
    const sealed = await encryptMemoContent('right', 'private body')
    await expect(decryptMemoContent('wrong', sealed)).rejects.toThrow('The passphrase did not open this memo')
  })

  it('refuses a tampered ciphertext', async () => {
    const sealed = await encryptMemoContent('right', 'private body')
    const parts = sealed.split(':')
    const data = parts[4] ?? ''
    parts[4] = `${data[0] === 'A' ? 'B' : 'A'}${data.slice(1)}`
    const tampered = parts.join(':')
    await expect(decryptMemoContent('right', tampered)).rejects.toThrow('The passphrase did not open this memo')
  })

  it('refuses a value that is not an envelope', async () => {
    await expect(decryptMemoContent('right', 'not-a-seal')).rejects.toThrow('does not carry a readable sealed body')
  })
})
