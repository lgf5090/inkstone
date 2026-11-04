/**
 * The one sealed-text primitive shared by the notebook and Memos.
 *
 * The wire format and work factor are Memos's `memoenc:v1` format, deliberately copied exactly so
 * an envelope written by either module opens in the other once both consume this module:
 *
 *   memoenc:v1:<base64url(salt)>:<base64url(iv)>:<base64url(ciphertext)>
 *
 * PBKDF2-SHA256 with 150,000 rounds derives a 256-bit AES-GCM key; the salt is 16 random bytes and
 * the nonce 12, stored beside the ciphertext. The passphrase never leaves the browser, the server
 * only stores the envelope, and AES-GCM's tag is what makes a wrong passphrase fail instead of
 * decrypting to garbage.
 *
 * `NoteLockSession` adds the session shape the notebook needs (one derivation reused across the
 * fields sealed under one passphrase prompt) while keeping every envelope in the shared format.
 */

const encoder = new TextEncoder()
const decoder = new TextDecoder()
const subtle = () => crypto.subtle

const PREFIX = 'memoenc:v1:'
const SALT_BYTES = 16
const IV_BYTES = 12
const KEY_BITS = 256

export const NOTE_LOCK_ENVELOPE_PREFIX = PREFIX
export const NOTE_LOCK_KDF_NAME = 'PBKDF2-SHA256'
/** Memos's work factor, shared so the two modules cannot drift into different strengths. */
export const NOTE_LOCK_KDF_ITERATIONS = 150_000
/** Fallback auto-lock window when a stored setting is missing or unusable. */
export const NOTE_LOCK_TIMEOUT_FALLBACK_MINUTES = 5

export type NoteLockField = 'title' | 'content'

/** The passphrase did not open this envelope, or the envelope is not one this format can read. */
export class NoteUnlockError extends Error {
  constructor(readonly code: 'wrong-password' | 'invalid-envelope') {
    super(code === 'wrong-password' ? 'The password does not open this lock' : 'The encrypted envelope is not valid')
    this.name = 'NoteUnlockError'
  }
}

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

function randomBytes(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length))
}

async function deriveKey(passphrase: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
  const raw = await subtle().importKey(
    'raw',
    encoder.encode(passphrase) as unknown as BufferSource,
    'PBKDF2',
    false,
    ['deriveKey'],
  )
  return subtle().deriveKey(
    { name: 'PBKDF2', salt: salt as unknown as BufferSource, iterations, hash: 'SHA-256' },
    raw,
    { name: 'AES-GCM', length: KEY_BITS },
    false,
    ['encrypt', 'decrypt'],
  )
}

/** Whether a stored string is a `memoenc:v1` envelope rather than text that happens to begin alike. */
export function isNoteLockEnvelope(value: string): boolean {
  if (!value.startsWith(PREFIX)) return false
  const parts = value.slice(PREFIX.length).split(':')
  return parts.length === 3 && parts.every((part) => part.length > 0)
}

/** The salt an envelope names, so a reader can reuse a cached session for the same passphrase. */
export function saltOfEnvelope(envelope: string): string | null {
  if (!isNoteLockEnvelope(envelope)) return null
  return envelope.slice(PREFIX.length).split(':')[0] ?? null
}

/** One passphrase prompt's key material: one PBKDF2 derivation reused for the note's fields. */
export class NoteLockSession {
  private constructor(
    readonly salt: string,
    readonly iterations: number,
    private readonly key: CryptoKey,
  ) {}

  static async create(
    passphrase: string,
    options: { salt?: string; iterations?: number } = {},
  ): Promise<NoteLockSession> {
    const trimmed = passphrase.trim()
    if (!trimmed) throw new NoteUnlockError('invalid-envelope')
    const salt = options.salt ?? toBase64Url(randomBytes(SALT_BYTES))
    const iterations = options.iterations ?? NOTE_LOCK_KDF_ITERATIONS
    const key = await deriveKey(trimmed, fromBase64Url(salt), iterations)
    return new NoteLockSession(salt, iterations, key)
  }

  async seal(plaintext: string): Promise<string> {
    const iv = toBase64Url(randomBytes(IV_BYTES))
    const sealed = await subtle().encrypt(
      { name: 'AES-GCM', iv: fromBase64Url(iv) as unknown as BufferSource },
      this.key,
      encoder.encode(plaintext),
    )
    return `${PREFIX}${this.salt}:${iv}:${toBase64Url(new Uint8Array(sealed))}`
  }

  async open(envelope: string): Promise<string> {
    if (!isNoteLockEnvelope(envelope)) throw new NoteUnlockError('invalid-envelope')
    const [salt, iv, data] = envelope.slice(PREFIX.length).split(':') as [string, string, string]
    // The session's key was derived for its own salt; a different salt belongs to another session.
    if (salt !== this.salt) throw new NoteUnlockError('invalid-envelope')
    try {
      const opened = await subtle().decrypt(
        { name: 'AES-GCM', iv: fromBase64Url(iv) as unknown as BufferSource },
        this.key,
        fromBase64Url(data) as unknown as BufferSource,
      )
      return decoder.decode(opened)
    } catch {
      throw new NoteUnlockError('wrong-password')
    }
  }
}

/** Seal a note's title and body under one session, one salt, two fresh nonces. */
export async function sealNote(
  session: NoteLockSession,
  noteId: string,
  note: { title: string; content: string },
): Promise<{ title: string; content: string }> {
  // The id is part of the call shape so a future field binding can be added without changing every
  // caller; the sealed value itself is the shared Memos format, which carries no per-note marker.
  void noteId
  return {
    title: await session.seal(note.title),
    content: await session.seal(note.content),
  }
}

/** Open a sealed note. Throws {@link NoteUnlockError} on a wrong password or an unreadable envelope. */
export async function openNote(
  session: NoteLockSession,
  noteId: string,
  note: { title: string; content: string },
): Promise<{ title: string; content: string }> {
  void noteId
  return {
    title: await session.open(note.title),
    content: await session.open(note.content),
  }
}

/**
 * The surface both features import now that Memos no longer keeps a private `memo-crypto.ts`:
 *  - `NoteLockSession.create(passphrase, { salt })` derives the Memos key; omit `salt` to seal a
 *    fresh row, pass the envelope's salt to open one;
 *  - `session.seal(plaintext)` / `session.open(envelope)` are the one-field operations Memos needs;
 *  - `isNoteLockEnvelope` is the `looksLikeMemoCipher` replacement, and `saltOfEnvelope` reads the
 *    stored salt without deriving a key;
 *  - `NoteUnlockError` (also exported as `NoteLockError`) separates "wrong passphrase" from "not a
 *    readable envelope", which is what Memos's two error messages already distinguish.
 * `sealNote`/`openNote` are the notebook's two-field convenience wrappers and are not required by
 * Memos. The compatibility tests in `tests/notes-lock-crypto.test.ts` parse this module's output
 * with Memos's own format and open an envelope Memos wrote, so a field-order or encoding drift
 * fails before either branch merges.
 */
