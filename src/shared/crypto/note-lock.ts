/**
 * The sealed-text primitives shared by the notebook and Memos.
 *
 * Memos keeps its original one-field wire format, with an implicit 150,000-round work factor:
 *
 *   memoenc:v1:<base64url(salt)>:<base64url(iv)>:<base64url(ciphertext)>
 *
 * Notes use a versioned, context-bound format instead:
 *
 *   memoenc:v2:<iterations>:<base64url(salt)>:<base64url(iv)>:<base64url(ciphertext)>
 *
 * PBKDF2-SHA256 derives a 256-bit AES-GCM key. Note ciphertext additionally authenticates the note id
 * and field as AAD, so moving either field to another note or swapping title and body fails closed.
 */

const encoder = new TextEncoder()
const decoder = new TextDecoder()
const subtle = () => crypto.subtle

const PREFIX = 'memoenc:v1:'
const V2_PREFIX = 'memoenc:v2:'
const SALT_BYTES = 16
const IV_BYTES = 12
const GCM_TAG_BYTES = 16
const KEY_BITS = 256
const BASE64URL = /^[A-Za-z0-9_-]+$/
const UNSIGNED_DECIMAL = /^[1-9]\d*$/
const NOTE_AAD_DOMAIN = 'inkstone:note-lock:v2'

export const NOTE_LOCK_ENVELOPE_PREFIX = PREFIX
export const NOTE_LOCK_KDF_NAME = 'PBKDF2-SHA256'
/** Memos's work factor, and the default for new note envelopes. */
export const NOTE_LOCK_KDF_ITERATIONS = 150_000
export const NOTE_LOCK_KDF_MIN_ITERATIONS = 100_000
export const NOTE_LOCK_KDF_MAX_ITERATIONS = 2_000_000
/** Fallback auto-lock window when a stored setting is missing or unusable. */
export const NOTE_LOCK_TIMEOUT_FALLBACK_MINUTES = 5

export type NoteLockField = 'title' | 'content'

export type ParsedNoteLockEnvelope = {
  version: 1 | 2
  iterations: number
  salt: string
  iv: string
  ciphertext: string
}

/** The passphrase did not open this envelope, or the envelope is not one this format can read. */
export class NoteUnlockError extends Error {
  constructor(readonly code: 'wrong-password' | 'invalid-envelope') {
    super(code === 'wrong-password' ? 'The password does not open this lock' : 'The encrypted envelope is not valid')
    this.name = 'NoteUnlockError'
  }
}

function invalidEnvelope(): never {
  throw new NoteUnlockError('invalid-envelope')
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** Decode only canonical, unpadded base64url; atob alone accepts several malformed spellings. */
function fromBase64Url(value: unknown, expectedBytes?: number): Uint8Array {
  if (typeof value !== 'string' || !BASE64URL.test(value) || value.length % 4 === 1) invalidEnvelope()
  const padded = value.replace(/-/g, '+').replace(/_/g, '/')
    + '='.repeat((4 - (value.length % 4)) % 4)
  let bytes: Uint8Array
  try {
    const binary = atob(padded)
    bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  } catch {
    invalidEnvelope()
  }
  if (toBase64Url(bytes) !== value || (expectedBytes !== undefined && bytes.length !== expectedBytes)) {
    invalidEnvelope()
  }
  return bytes
}

function assertIterations(value: unknown): asserts value is number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < NOTE_LOCK_KDF_MIN_ITERATIONS ||
    value > NOTE_LOCK_KDF_MAX_ITERATIONS
  ) {
    invalidEnvelope()
  }
}

function parseIterations(value: string): number {
  if (!UNSIGNED_DECIMAL.test(value)) invalidEnvelope()
  const iterations = Number(value)
  assertIterations(iterations)
  return iterations
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

/**
 * Validate and parse either supported envelope before any key derivation or decryption is attempted.
 * Unknown versions, non-canonical base64url, wrong salt/nonce sizes and unsafe work factors are invalid.
 */
export function parseNoteLockEnvelope(value: string): ParsedNoteLockEnvelope {
  if (typeof value !== 'string') invalidEnvelope()
  const version = value.startsWith(V2_PREFIX) ? 2 : value.startsWith(PREFIX) ? 1 : 0
  if (version === 0) invalidEnvelope()
  const prefix = version === 2 ? V2_PREFIX : PREFIX
  const parts = value.slice(prefix.length).split(':')
  if (parts.length !== (version === 2 ? 4 : 3)) invalidEnvelope()

  const iterations = version === 2 ? parseIterations(parts[0]!) : NOTE_LOCK_KDF_ITERATIONS
  const salt = version === 2 ? parts[1]! : parts[0]!
  const iv = version === 2 ? parts[2]! : parts[1]!
  const ciphertext = version === 2 ? parts[3]! : parts[2]!
  fromBase64Url(salt, SALT_BYTES)
  fromBase64Url(iv, IV_BYTES)
  if (fromBase64Url(ciphertext).length < GCM_TAG_BYTES) invalidEnvelope()
  return { version, iterations, salt, iv, ciphertext }
}

/** Parse both fields and reject mixed versions, salts or work factors before opening either one. */
export function parseNoteLockNote(note: { title: string; content: string }): {
  title: ParsedNoteLockEnvelope
  content: ParsedNoteLockEnvelope
} {
  if (!note || typeof note.title !== 'string' || typeof note.content !== 'string') invalidEnvelope()
  const title = parseNoteLockEnvelope(note.title)
  const content = parseNoteLockEnvelope(note.content)
  if (
    title.version !== content.version ||
    title.salt !== content.salt ||
    title.iterations !== content.iterations
  ) {
    invalidEnvelope()
  }
  return { title, content }
}

/** Whether a stored string is a fully valid v1 or v2 envelope rather than text that happens to begin alike. */
export function isNoteLockEnvelope(value: string): boolean {
  try {
    parseNoteLockEnvelope(value)
    return true
  } catch {
    return false
  }
}

/** The salt an envelope names, so a reader can reuse a cached session for the same passphrase. */
export function saltOfEnvelope(envelope: string): string | null {
  try {
    return parseNoteLockEnvelope(envelope).salt
  } catch {
    return null
  }
}

/** The explicit v2 work factor, or v1's implicit one. Invalid envelopes have no readable work factor. */
export function iterationsOfEnvelope(envelope: string): number | null {
  try {
    return parseNoteLockEnvelope(envelope).iterations
  } catch {
    return null
  }
}

function noteAad(noteId: string, field: NoteLockField): Uint8Array {
  return encoder.encode(`${NOTE_AAD_DOMAIN}:${JSON.stringify([noteId, field])}`)
}

function assertNoteContext(noteId: string, field: NoteLockField): void {
  if (typeof noteId !== 'string' || !noteId || (field !== 'title' && field !== 'content')) invalidEnvelope()
}

/** The one whitespace policy for note passwords: surrounding whitespace is never key material. */
export function normalizeNoteLockPassword(passphrase: string): string {
  return passphrase.trim()
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
    const normalized = normalizeNoteLockPassword(passphrase)
    if (!normalized) throw new NoteUnlockError('invalid-envelope')
    const iterations = options.iterations ?? NOTE_LOCK_KDF_ITERATIONS
    assertIterations(iterations)
    const salt = options.salt ?? toBase64Url(randomBytes(SALT_BYTES))
    const saltBytes = fromBase64Url(salt, SALT_BYTES)
    const key = await deriveKey(normalized, saltBytes, iterations)
    return new NoteLockSession(salt, iterations, key)
  }

  /** Validate an envelope's work factor before deriving its key. */
  static async fromEnvelope(passphrase: string, envelope: string): Promise<NoteLockSession> {
    const parsed = parseNoteLockEnvelope(envelope)
    return NoteLockSession.create(passphrase, { salt: parsed.salt, iterations: parsed.iterations })
  }

  private async sealWith(
    prefix: string,
    plaintext: string,
    additionalData?: Uint8Array,
    iterations?: number,
  ): Promise<string> {
    const iv = toBase64Url(randomBytes(IV_BYTES))
    const sealed = await subtle().encrypt(
      {
        name: 'AES-GCM',
        iv: fromBase64Url(iv, IV_BYTES) as unknown as BufferSource,
        additionalData: additionalData as unknown as BufferSource,
      },
      this.key,
      encoder.encode(plaintext),
    )
    const header = iterations === undefined ? `${prefix}${this.salt}` : `${prefix}${iterations}:${this.salt}`
    return `${header}:${iv}:${toBase64Url(new Uint8Array(sealed))}`
  }

  private assertSessionMatches(parsed: ParsedNoteLockEnvelope): void {
    // The session's key was derived for its own salt and work factor; another envelope's parameters
    // belong to another session even when its salt spelling happens to match.
    if (parsed.salt !== this.salt || parsed.iterations !== this.iterations) invalidEnvelope()
  }

  private async openParsed(parsed: ParsedNoteLockEnvelope, additionalData?: Uint8Array): Promise<string> {
    this.assertSessionMatches(parsed)
    const iv = fromBase64Url(parsed.iv, IV_BYTES)
    const ciphertext = fromBase64Url(parsed.ciphertext)
    try {
      const opened = await subtle().decrypt(
        {
          name: 'AES-GCM',
          iv: iv as unknown as BufferSource,
          additionalData: additionalData as unknown as BufferSource,
        },
        this.key,
        ciphertext as unknown as BufferSource,
      )
      return decoder.decode(opened)
    } catch {
      throw new NoteUnlockError('wrong-password')
    }
  }

  /** Memos's one-field operation. Its wire format remains memoenc:v1 with no AAD. */
  async seal(plaintext: string): Promise<string> {
    if (this.iterations !== NOTE_LOCK_KDF_ITERATIONS) throw new NoteUnlockError('invalid-envelope')
    return this.sealWith(PREFIX, plaintext)
  }

  /** Open a Memos-compatible v1 envelope. Note envelopes use openNote instead. */
  async open(envelope: string): Promise<string> {
    const parsed = parseNoteLockEnvelope(envelope)
    if (parsed.version !== 1) invalidEnvelope()
    return this.openParsed(parsed)
  }

  /** Notebook-only v2 field seal; callers should normally use sealNote for the matched pair. */
  async sealNoteField(noteId: string, field: NoteLockField, plaintext: string): Promise<string> {
    assertNoteContext(noteId, field)
    return this.sealWith(V2_PREFIX, plaintext, noteAad(noteId, field), this.iterations)
  }

  /** Notebook-only field open. Legacy v1 notes remain readable without AAD. */
  async openNoteField(noteId: string, field: NoteLockField, envelope: string): Promise<string> {
    assertNoteContext(noteId, field)
    const parsed = parseNoteLockEnvelope(envelope)
    return this.openParsed(parsed, parsed.version === 2 ? noteAad(noteId, field) : undefined)
  }
}

/** Seal a note's title and body under one session, one salt/work factor and two fresh nonces. */
export async function sealNote(
  session: NoteLockSession,
  noteId: string,
  note: { title: string; content: string },
): Promise<{ title: string; content: string }> {
  assertNoteContext(noteId, 'title')
  return {
    title: await session.sealNoteField(noteId, 'title', note.title),
    content: await session.sealNoteField(noteId, 'content', note.content),
  }
}

/** Open a v1 or v2 note. Throws {@link NoteUnlockError} on a wrong password or an unreadable envelope. */
export async function openNote(
  session: NoteLockSession,
  noteId: string,
  note: { title: string; content: string },
): Promise<{ title: string; content: string }> {
  parseNoteLockNote(note)
  assertNoteContext(noteId, 'title')
  return {
    title: await session.openNoteField(noteId, 'title', note.title),
    content: await session.openNoteField(noteId, 'content', note.content),
  }
}
