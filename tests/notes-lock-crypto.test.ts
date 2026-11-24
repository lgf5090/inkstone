// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import {
  NOTE_LOCK_KDF_ITERATIONS,
  NOTE_LOCK_KDF_MAX_ITERATIONS,
  NOTE_LOCK_KDF_MIN_ITERATIONS,
  NoteLockSession,
  NoteUnlockError,
  isNoteLockEnvelope,
  iterationsOfEnvelope,
  openNote,
  parseNoteLockEnvelope,
  saltOfEnvelope,
  sealNote,
} from '../src/shared/crypto'

/**
 * The encryption primitive is the only thing that stands between a password and a note's words.
 *
 * These cases pin the two wire formats and the properties the features rely on: the same password
 * opens what it sealed, a wrong password cannot, and a v2 field cannot move to another note or field.
 */

const FAST = { iterations: NOTE_LOCK_KDF_MIN_ITERATIONS }
const V2_PREFIX = 'memoenc:v2:'

/** Literal bytes written by the original v1 primitive, before note-specific AAD existed. */
const V1_TITLE = 'memoenc:v1:MDEyMzQ1Njc4OWFiY2RlZg:AAECAwQFBgcICQoL:FMTWLJk0wmu0Cy1AXOh8hiCoNyjz2nFQrxkhwQ'
const V1_CONTENT = 'memoenc:v1:MDEyMzQ1Njc4OWFiY2RlZg:EBESExQVFhcYGRob:A2Za-kthB_yqNn99GgvTCLWWQ7IaSy89GcHy'

function v2Parts(envelope: string): string[] {
  return envelope.slice(V2_PREFIX.length).split(':')
}

function replaceV2Part(envelope: string, index: number, value: string): string {
  const parts = v2Parts(envelope)
  parts[index] = value
  return `${V2_PREFIX}${parts.join(':')}`
}

describe('a v2 locked note round-trips', () => {
  it('emits iterations, salt, iv and ciphertext, then opens both fields', async () => {
    const session = await NoteLockSession.create('correct horse', FAST)
    const sealed = await sealNote(session, 'note-1', { title: 'Secret title', content: 'Body with 中文 and emoji 🚀' })

    expect(sealed.title.startsWith(V2_PREFIX)).toBe(true)
    expect(sealed.content.startsWith(V2_PREFIX)).toBe(true)
    expect(v2Parts(sealed.title)).toHaveLength(4)
    expect(v2Parts(sealed.content)).toHaveLength(4)
    expect(iterationsOfEnvelope(sealed.title)).toBe(FAST.iterations)
    expect(saltOfEnvelope(sealed.title)).toBe(session.salt)
    expect(saltOfEnvelope(sealed.content)).toBe(session.salt)
    expect(isNoteLockEnvelope(sealed.title)).toBe(true)
    expect(isNoteLockEnvelope(sealed.content)).toBe(true)

    const reopened = await NoteLockSession.fromEnvelope('correct horse', sealed.title)
    await expect(openNote(reopened, 'note-1', sealed)).resolves.toEqual({
      title: 'Secret title',
      content: 'Body with 中文 and emoji 🚀',
    })
  })

  it('uses a fresh nonce for each field', async () => {
    const sealed = await sealNote(await NoteLockSession.create('pw', FAST), 'n', { title: 't', content: 'c' })
    expect(v2Parts(sealed.title)[2]).not.toBe(v2Parts(sealed.content)[2])
  })
})

describe('a v2 lock refuses what it should not open', () => {
  it('throws a wrong-password error for the wrong password', async () => {
    const sealed = await sealNote(await NoteLockSession.create('right', FAST), 'n', { title: 't', content: 'c' })
    const wrong = await NoteLockSession.fromEnvelope('wrong', sealed.title)
    await expect(openNote(wrong, 'n', sealed)).rejects.toMatchObject({ code: 'wrong-password' })
  })

  it('refuses a field moved to another note even when both notes share a key', async () => {
    const session = await NoteLockSession.create('pw', FAST)
    const first = await sealNote(session, 'note-a', { title: 'Title A', content: 'Body A' })
    const second = await sealNote(session, 'note-b', { title: 'Title B', content: 'Body B' })

    await expect(openNote(session, 'note-a', { title: second.title, content: first.content }))
      .rejects.toMatchObject({ code: 'wrong-password' })
  })

  it('refuses title and content swapped between fields', async () => {
    const session = await NoteLockSession.create('pw', FAST)
    const sealed = await sealNote(session, 'note-a', { title: 'Title', content: 'Body' })

    await expect(openNote(session, 'note-a', { title: sealed.content, content: sealed.title }))
      .rejects.toMatchObject({ code: 'wrong-password' })
  })

  it('refuses a ciphertext edited in place', async () => {
    const session = await NoteLockSession.create('pw', FAST)
    const sealed = await sealNote(session, 'n', { title: 't', content: 'c' })
    const data = v2Parts(sealed.content)[3]!
    const tampered = replaceV2Part(sealed.content, 3, `${data[0] === 'A' ? 'B' : 'A'}${data.slice(1)}`)

    await expect(openNote(session, 'n', { title: sealed.title, content: tampered }))
      .rejects.toMatchObject({ code: 'wrong-password' })
  })

  it('refuses an envelope sealed under a different salt', async () => {
    const sealed = await sealNote(await NoteLockSession.create('pw', FAST), 'a', { title: 't', content: 'c' })
    const other = await NoteLockSession.create('pw', FAST)
    await expect(openNote(other, 'a', sealed)).rejects.toMatchObject({ code: 'invalid-envelope' })
  })

  it('requires title and content to name the same salt', async () => {
    const session = await NoteLockSession.create('pw', FAST)
    const sealed = await sealNote(session, 'n', { title: 't', content: 'c' })
    const otherSalt = 'A'.repeat(22) // Canonical base64url for a different 16-byte salt.

    await expect(openNote(session, 'n', { title: replaceV2Part(sealed.title, 1, otherSalt), content: sealed.content }))
      .rejects.toMatchObject({ code: 'invalid-envelope' })
  })

  it('requires title and content to name the same iteration count', async () => {
    const session = await NoteLockSession.create('pw', FAST)
    const sealed = await sealNote(session, 'n', { title: 't', content: 'c' })
    const title = replaceV2Part(sealed.title, 0, String(FAST.iterations + 1))

    await expect(openNote(session, 'n', { title, content: sealed.content }))
      .rejects.toMatchObject({ code: 'invalid-envelope' })
  })
})

describe('envelope validation happens before key derivation', () => {
  it('rejects malformed shapes, base64url, salt/nonce sizes and short ciphertexts', async () => {
    const sealed = await sealNote(await NoteLockSession.create('pw', FAST), 'n', { title: 't', content: 'c' })
    const [iterations, salt, iv, data] = v2Parts(sealed.title)
    const malformed = [
      'plain text',
      'memoenc:v3:100000:AA:AA:AA',
      `memoenc:v2:${iterations}:${salt}:${iv}`,
      `memoenc:v2:${iterations}:${salt}:${iv}:${data}:extra`,
      `memoenc:v2:${iterations}:${salt}=:${iv}:${data}`,
      `memoenc:v2:${iterations}:${'A'.repeat(21)}B:${iv}:${data}`,
      `memoenc:v2:${iterations}:AA:${iv}:${data}`,
      `memoenc:v2:${iterations}:${salt}:AA:${data}`,
      `memoenc:v2:${iterations}:${salt}:${iv}:AA`,
      'memoenc:v1:AA:AA:AA',
    ]

    for (const envelope of malformed) {
      expect(isNoteLockEnvelope(envelope), envelope).toBe(false)
      expect(() => parseNoteLockEnvelope(envelope), envelope).toThrow(NoteUnlockError)
    }
  })

  it.each([
    '',
    '0',
    String(NOTE_LOCK_KDF_MIN_ITERATIONS - 1),
    String(NOTE_LOCK_KDF_MAX_ITERATIONS + 1),
    '0100000',
    '1e5',
    '100000.0',
    '-1',
    '9007199254740992',
  ])('rejects the invalid iteration value %j', (iterations) => {
    const envelope = `memoenc:v2:${iterations}:${'A'.repeat(22)}:${'A'.repeat(16)}:${'A'.repeat(22)}`
    expect(isNoteLockEnvelope(envelope)).toBe(false)
    expect(() => parseNoteLockEnvelope(envelope)).toThrow(NoteUnlockError)
  })

  it('does not call PBKDF2 for an oversized stored iteration count', async () => {
    const envelope = `memoenc:v2:${NOTE_LOCK_KDF_MAX_ITERATIONS + 1}:${'A'.repeat(22)}:${'A'.repeat(16)}:${'A'.repeat(22)}`
    const deriveKey = vi.spyOn(crypto.subtle, 'deriveKey')
    try {
      await expect(NoteLockSession.fromEnvelope('pw', envelope)).rejects.toMatchObject({ code: 'invalid-envelope' })
      expect(deriveKey).not.toHaveBeenCalled()
    } finally {
      deriveKey.mockRestore()
    }
  })

  it('does not call PBKDF2 for invalid session options', async () => {
    const deriveKey = vi.spyOn(crypto.subtle, 'deriveKey')
    try {
      await expect(NoteLockSession.create('pw', {
        salt: 'A'.repeat(22),
        iterations: NOTE_LOCK_KDF_MAX_ITERATIONS + 1,
      })).rejects.toMatchObject({ code: 'invalid-envelope' })
      expect(deriveKey).not.toHaveBeenCalled()
    } finally {
      deriveKey.mockRestore()
    }
  })
})

describe('v1 fixtures stay readable', () => {
  it('opens a legacy note with the implicit 150,000-round work factor and no AAD', async () => {
    expect(iterationsOfEnvelope(V1_TITLE)).toBe(NOTE_LOCK_KDF_ITERATIONS)
    const session = await NoteLockSession.fromEnvelope('fixture password', V1_TITLE)

    await expect(openNote(session, 'legacy-note', { title: V1_TITLE, content: V1_CONTENT })).resolves.toEqual({
      title: 'Legacy title',
      content: 'Legacy body',
    })
  })
})

describe('the generic session stays byte-compatible with Memos memoenc:v1', () => {
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

  it('writes the unchanged v1 envelope that Memos reads with its own parser', async () => {
    const sealed = await (await NoteLockSession.create('shared pass')).seal('memo body')
    expect(sealed.startsWith(MEMO_PREFIX)).toBe(true)
    expect(sealed.slice(MEMO_PREFIX.length).split(':')).toHaveLength(3)
    await expect(memoOpen('shared pass', sealed)).resolves.toBe('memo body')
  })

  it('opens an envelope Memos wrote', async () => {
    const envelope = await memoSeal('shared pass', 'memo body')
    const session = await NoteLockSession.fromEnvelope('shared pass', envelope)
    await expect(session.open(envelope)).resolves.toBe('memo body')
  })

  it('does not let the generic one-field opener read a context-bound v2 envelope', async () => {
    const session = await NoteLockSession.create('pw', FAST)
    const sealed = await sealNote(session, 'n', { title: 't', content: 'c' })
    await expect(session.open(sealed.title)).rejects.toMatchObject({ code: 'invalid-envelope' })
  })
})
