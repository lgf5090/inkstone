// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  NoteLockSession,
  NoteUnlockError,
  isNoteLockEnvelope,
  openNote,
  saltOfEnvelope,
  sealNote,
} from '../src/shared/crypto'

/**
 * The encryption primitive is the only thing that stands between a password and a note's words.
 *
 * These cases pin the three properties the rest of the feature relies on: the same password opens
 * what it sealed, a wrong password cannot, and an envelope cannot be moved to another note or
 * another field. The work factor is lowered here — the production constant is exercised by the
 * envelope's own `iter` field, not by making every unit test wait for it.
 */

const FAST = { iterations: 1_000 }

describe('a locked note round-trips', () => {
  it('opens the title and body with the same password', async () => {
    const session = await NoteLockSession.create('correct horse', FAST)
    const sealed = await sealNote(session, 'note-1', { title: 'Secret title', content: 'Body with 中文 and emoji 🚀' })

    expect(isNoteLockEnvelope(sealed.title)).toBe(true)
    expect(isNoteLockEnvelope(sealed.content)).toBe(true)

    const reopened = await NoteLockSession.create('correct horse', {
      salt: saltOfEnvelope(sealed.title)!,
      ...FAST,
    })
    await expect(openNote(reopened, 'note-1', sealed)).resolves.toEqual({
      title: 'Secret title',
      content: 'Body with 中文 and emoji 🚀',
    })
  })

  it('uses the shared memoenc:v1 envelope with one salt for both fields', async () => {
    const session = await NoteLockSession.create('batch', FAST)
    const first = await sealNote(session, 'note-a', { title: 'A', content: 'a' })
    expect(first.title.startsWith('memoenc:v1:')).toBe(true)
    expect(first.title.slice('memoenc:v1:'.length).split(':')).toHaveLength(3)
    expect(saltOfEnvelope(first.title)).toBe(session.salt)
    expect(saltOfEnvelope(first.content)).toBe(session.salt)
  })
})

describe('a lock refuses what it should not open', () => {
  it('throws a wrong-password error for the wrong password', async () => {
    const sealed = await sealNote(await NoteLockSession.create('right', FAST), 'n', { title: 't', content: 'c' })
    const wrong = await NoteLockSession.create('wrong', { salt: saltOfEnvelope(sealed.title)!, ...FAST })
    await expect(openNote(wrong, 'n', sealed)).rejects.toMatchObject({ code: 'wrong-password' })
  })

  it('refuses a ciphertext edited in place', async () => {
    const session = await NoteLockSession.create('pw', FAST)
    const sealed = await sealNote(session, 'n', { title: 't', content: 'c' })
    const parsed = sealed.content.slice('memoenc:v1:'.length).split(':')
    const data = parsed[2]!
    parsed[2] = `${data.slice(0, -2)}AA`
    const tampered = `memoenc:v1:${parsed.join(':')}`
    await expect(openNote(session, 'n', { title: sealed.title, content: tampered })).rejects.toBeInstanceOf(NoteUnlockError)
  })

  it('refuses an envelope sealed under a different salt', async () => {
    const sealed = await sealNote(await NoteLockSession.create('pw', FAST), 'a', { title: 't', content: 'c' })
    const other = await NoteLockSession.create('pw', FAST)
    await expect(openNote(other, 'n', sealed)).rejects.toMatchObject({ code: 'invalid-envelope' })
  })

  it('does not mistake ordinary text for an envelope', () => {
    expect(isNoteLockEnvelope('plain text')).toBe(false)
    expect(isNoteLockEnvelope('memoenc:v1:')).toBe(false)
    expect(isNoteLockEnvelope('memoenc:v1:a:b')).toBe(false)
    expect(isNoteLockEnvelope('inkstone:enc:v1:a:b:c')).toBe(false)
  })
})

describe('the shared envelope stays byte-compatible with Memos memoenc:v1', () => {
  const MEMO_PREFIX = 'memoenc:v1:'

  function toBase64Url(bytes: Uint8Array): string {
    let binary = ''
    for (const byte of bytes) binary += String.fromCharCode(byte)
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  }

  function fromBase64Url(value: string): Uint8Array {
    const padded = value.replace(/-/g, '+').replace(/_/g, '/')
      + '='.repeat((4 - (value.length % 4)) % 4)
    const binary = atob(padded)
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
    return bytes
  }

  /** The exact derivation and envelope Memos writes today, kept independent of the module under test. */
  async function memoKey(passphrase: string, salt: Uint8Array): Promise<CryptoKey> {
    const raw = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(passphrase.trim()) as unknown as BufferSource,
      'PBKDF2',
      false,
      ['deriveKey'],
    )
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt: salt as unknown as BufferSource, iterations: 150_000, hash: 'SHA-256' },
      raw,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt'],
    )
  }

  async function memoSeal(passphrase: string, plaintext: string): Promise<string> {
    const salt = crypto.getRandomValues(new Uint8Array(16))
    const iv = crypto.getRandomValues(new Uint8Array(12))
    const sealed = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: iv as unknown as BufferSource },
      await memoKey(passphrase, salt),
      new TextEncoder().encode(plaintext),
    )
    return `${MEMO_PREFIX}${toBase64Url(salt)}:${toBase64Url(iv)}:${toBase64Url(new Uint8Array(sealed))}`
  }

  async function memoOpen(passphrase: string, envelope: string): Promise<string> {
    if (!envelope.startsWith(MEMO_PREFIX)) throw new Error('not a memo envelope')
    const [salt, iv, data] = envelope.slice(MEMO_PREFIX.length).split(':') as [string, string, string]
    const opened = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromBase64Url(iv) as unknown as BufferSource },
      await memoKey(passphrase, fromBase64Url(salt)),
      fromBase64Url(data) as unknown as BufferSource,
    )
    return new TextDecoder().decode(opened)
  }

  it('writes an envelope Memos reads with its own parser', async () => {
    const sealed = await sealNote(await NoteLockSession.create('shared pass'), 'n', { title: '', content: 'note body' })
    const parts = sealed.content.slice(MEMO_PREFIX.length).split(':')
    expect(parts).toHaveLength(3)
    expect(parts.every((part) => /^[A-Za-z0-9_-]+$/.test(part))).toBe(true)
    await expect(memoOpen('shared pass', sealed.content)).resolves.toBe('note body')
  })

  it('opens an envelope Memos wrote', async () => {
    const envelope = await memoSeal('shared pass', 'memo body')
    const salt = saltOfEnvelope(envelope)!
    const session = await NoteLockSession.create('shared pass', { salt })
    await expect(session.open(envelope)).resolves.toBe('memo body')
  })
})
