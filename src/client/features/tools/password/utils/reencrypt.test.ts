import { describe, expect, it } from 'vitest'
import { decryptValue, encryptValue, getKeyIv } from '../crypto'
import { reencryptAccounts } from './reencrypt'

const OLD = getKeyIv('abcdef')
const NEXT = getKeyIv('ghijkl')

function source(
  overrides: Partial<Record<'id' | 'title' | 'username' | 'password' | 'link' | 'remark', string>> = {},
) {
  return {
    id: 'acc-1',
    title: encryptValue(OLD, 'GitHub'),
    username: encryptValue(OLD, 'octocat'),
    password: encryptValue(OLD, 'hunter2'),
    link: encryptValue(OLD, 'https://github.com'),
    remark: encryptValue(OLD, 'work'),
    ...overrides,
  }
}

describe('reencryptAccounts', () => {
  it('re-seals every field so the new key reads back the original plaintext', () => {
    const { rows, failedIndex } = reencryptAccounts([source()], OLD, NEXT)

    expect(failedIndex).toBe(-1)
    expect(decryptValue(NEXT, rows[0]!.title)).toBe('GitHub')
    expect(decryptValue(NEXT, rows[0]!.username)).toBe('octocat')
    expect(decryptValue(NEXT, rows[0]!.password)).toBe('hunter2')
    expect(decryptValue(NEXT, rows[0]!.link)).toBe('https://github.com')
    expect(decryptValue(NEXT, rows[0]!.remark)).toBe('work')
  })

  it('keeps empty fields empty instead of sealing an empty string', () => {
    const { rows, failedIndex } = reencryptAccounts([source({ remark: '' })], OLD, NEXT)
    expect(failedIndex).toBe(-1)
    expect(rows[0]!.remark).toBe('')
  })

  it('reports the row whose ciphertext the old key cannot open, and never re-seals it', () => {
    // 'deadbeef' is valid hex but not a CBC block, so decryption fails — the class of row that
    // used to be encrypted a second time and lost forever.
    const { rows, failedIndex } = reencryptAccounts(
      [source(), source({ id: 'acc-2', password: 'deadbeef' })],
      OLD,
      NEXT,
    )

    expect(failedIndex).toBe(1)
    // Aborting is the caller's job, but the failed field must not carry a value that a naive
    // caller could upload: an empty string is skipped, a sealed ciphertext is not.
    expect(rows[1]!.password).toBe('')
    expect(rows[0]!.password).not.toBe('')
  })

  it('refuses to reinterpret a value the old key cannot open, including a legacy plaintext row', () => {
    // A row stored before encryption (or under a different master password) cannot be classified
    // from its bytes alone. Aborting is the only choice that cannot lose it: re-sealing it would
    // either encrypt ciphertext twice or overwrite the value behind the new key.
    const { rows, failedIndex } = reencryptAccounts([source({ title: 'legacy-plain-title' })], OLD, NEXT)
    expect(failedIndex).toBe(0)
    expect(rows[0]!.title).toBe('')
  })
})
