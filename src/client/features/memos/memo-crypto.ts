import { MEMO_CIPHER_PREFIX } from '@shared/memos/constants'

const PBKDF2_ITERATIONS = 150_000
const SALT_BYTES = 16
const IV_BYTES = 12
const KEY_BITS = 256
const subtle = (): SubtleCrypto => {
  const cryptoApi = globalThis.crypto
  if (!cryptoApi?.subtle) {
    throw new Error('Web Crypto is unavailable, so memo sealing cannot run in this browser')
  }
  return cryptoApi.subtle
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
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
  return bytes
}

/**
 * The memo's key: scrypt-strength work is delegated to PBKDF2 here because the browser exposes it
 * natively; 150k SHA-256 rounds is the cost a stolen database pays per guess, and the salt is stored
 * with each row so two memos never share key material.
 */
async function deriveKey(passphrase: string, salt: Uint8Array): Promise<CryptoKey> {
  const raw = await subtle().importKey(
    'raw',
    new TextEncoder().encode(passphrase) as BufferSource,
    'PBKDF2',
    false,
    ['deriveKey'],
  )
  return subtle().deriveKey(
    { name: 'PBKDF2', salt: salt as BufferSource, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    raw,
    { name: 'AES-GCM', length: KEY_BITS },
    false,
    ['encrypt', 'decrypt'],
  )
}

/**
 * Seal a memo body under the reader's passphrase.
 *
 * The plaintext never leaves this function: what returns is the envelope the server stores. AES-GCM
 * authenticates, so a wrong passphrase or a tampered row fails instead of decrypting to garbage.
 */
export async function encryptMemoContent(passphrase: string, plaintext: string): Promise<string> {
  const trimmedPassphrase = passphrase.trim()
  if (!trimmedPassphrase) throw new Error('A passphrase is required to seal a memo')
  const cryptoApi = globalThis.crypto
  if (!cryptoApi) throw new Error('Web Crypto is unavailable, so memo sealing cannot run in this browser')
  const salt = cryptoApi.getRandomValues(new Uint8Array(SALT_BYTES))
  const iv = cryptoApi.getRandomValues(new Uint8Array(IV_BYTES))
  const key = await deriveKey(trimmedPassphrase, salt)
  const sealed = await subtle().encrypt(
    { name: 'AES-GCM', iv: iv as BufferSource },
    key,
    new TextEncoder().encode(plaintext),
  )
  return [
    `${MEMO_CIPHER_PREFIX}${toBase64Url(salt)}`,
    toBase64Url(iv),
    toBase64Url(new Uint8Array(sealed)),
  ].join(':')
}

export function looksLikeMemoCipher(value: string): boolean {
  return value.startsWith(MEMO_CIPHER_PREFIX)
    && value.slice(MEMO_CIPHER_PREFIX.length).split(':').length === 3
}

/** Open a sealed body. Throws with a reader-facing reason rather than returning half-decoded text. */
export async function decryptMemoContent(passphrase: string, ciphertext: string): Promise<string> {
  const trimmedPassphrase = passphrase.trim()
  if (!trimmedPassphrase) throw new Error('A passphrase is required to open a sealed memo')
  if (!looksLikeMemoCipher(ciphertext)) throw new Error('This memo does not carry a readable sealed body')
  const parts = ciphertext.slice(MEMO_CIPHER_PREFIX.length).split(':')
  if (parts.length !== 3) throw new Error('This memo does not carry a readable sealed body')
  const [saltPart, ivPart, dataPart] = parts as [string, string, string]
  try {
    const salt = fromBase64Url(saltPart)
    const iv = fromBase64Url(ivPart)
    const key = await deriveKey(trimmedPassphrase, salt)
    const opened = await subtle().decrypt(
      { name: 'AES-GCM', iv: iv as BufferSource },
      key,
      fromBase64Url(dataPart) as BufferSource,
    )
    return new TextDecoder().decode(opened)
  } catch (error) {
    throw new Error('The passphrase did not open this memo', { cause: error })
  }
}
