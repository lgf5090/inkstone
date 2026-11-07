import { fromBase64, fromUtf8, toBase64, utf8 } from '../lib/encoding'
import { bcryptPbkdf } from './bcrypt-pbkdf'

export type OpenSshKeyFailure = 'invalid' | 'unsupported' | 'passphrase_required' | 'passphrase_invalid'

export class OpenSshKeyError extends Error {
  constructor(readonly reason: OpenSshKeyFailure, message: string) {
    super(message)
    this.name = 'OpenSshKeyError'
  }
}

export interface OpenSshKeyInfo {
  algorithm: string
  publicKey: string
  fingerprint: string
  encrypted: boolean
}

/**
 * The parsed key plus the decrypted, still-padded private section. The protocol core needs the raw
 * section to lift a signing key out of it; callers that only need metadata use
 * `inspectOpenSshPrivateKey`.
 */
export interface OpenSshKeyMaterial extends OpenSshKeyInfo {
  publicKeyBlob: Uint8Array
  privateKeySection: Uint8Array
  /** Padding block size of the decrypted private section: 8 unencrypted, 16 for AES. */
  blockSize: number
}

const OPENSSH_HEADER = /^-----BEGIN OPENSSH PRIVATE KEY-----([A-Za-z0-9+/=\s]+)-----END OPENSSH PRIVATE KEY-----$/
const OPENSSH_MAGIC = utf8('openssh-key-v1\0')
const MAX_PRIVATE_KEY_BYTES = 16 * 1024
const MAX_PASSPHRASE_BYTES = 1024
const MAX_BCRYPT_ROUNDS = 100

const CIPHER_KEY_BYTES: Record<string, number> = {
  'aes128-ctr': 16,
  'aes192-ctr': 24,
  'aes256-ctr': 32,
  'aes128-cbc': 16,
  'aes192-cbc': 24,
  'aes256-cbc': 32,
}

const KEY_TYPE_PATTERN = /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp256|ecdsa-sha2-nistp384|ecdsa-sha2-nistp521)$/

interface FieldReader {
  offset: number
}

function readUint32(bytes: Uint8Array, reader: FieldReader): number {
  if (reader.offset + 4 > bytes.length) throw invalid('The private key is truncated')
  const value = ((bytes[reader.offset]! << 24) | (bytes[reader.offset + 1]! << 16) | (bytes[reader.offset + 2]! << 8) | bytes[reader.offset + 3]!) >>> 0
  reader.offset += 4
  return value
}

function readString(bytes: Uint8Array, reader: FieldReader): Uint8Array {
  const length = readUint32(bytes, reader)
  if (length > bytes.length - reader.offset) throw invalid('The private key is truncated')
  const value = bytes.subarray(reader.offset, reader.offset + length)
  reader.offset += length
  return value
}

function readText(bytes: Uint8Array, reader: FieldReader): string {
  return fromUtf8(readString(bytes, reader))
}

function invalid(message: string): OpenSshKeyError {
  return new OpenSshKeyError('invalid', message)
}

function unsupported(message: string): OpenSshKeyError {
  return new OpenSshKeyError('unsupported', message)
}

function canonicalBase64(text: string): Uint8Array {
  let bytes: Uint8Array
  try {
    bytes = fromBase64(text)
  } catch {
    throw invalid('The private key is not valid Base64 data')
  }
  if (toBase64(bytes) !== text) throw invalid('The private key is not valid Base64 data')
  return bytes
}

export function publicKeyAlgorithm(blob: Uint8Array): string {
  const reader: FieldReader = { offset: 0 }
  const kind = readText(blob, reader)
  if (!KEY_TYPE_PATTERN.test(kind)) throw unsupported(`Unsupported SSH key type "${kind}"`)
  if (reader.offset >= blob.length) throw invalid('The public key is truncated')
  return kind
}

export async function inspectOpenSshPrivateKey(pem: string, passphrase?: string): Promise<OpenSshKeyInfo> {
  const { algorithm, publicKey, fingerprint, encrypted } = await openOpenSshPrivateKey(pem, passphrase)
  return { algorithm, publicKey, fingerprint, encrypted }
}

export async function openOpenSshPrivateKey(pem: string, passphrase?: string): Promise<OpenSshKeyMaterial> {
  const trimmed = pem.trim()
  const match = OPENSSH_HEADER.exec(trimmed)
  if (!match) throw unsupported('Only OpenSSH-format private keys are supported')
  const base64 = match[1]!.replace(/\s+/g, '')
  if (!base64 || base64.length % 4 !== 0) throw invalid('The private key is not valid Base64 data')
  const raw = canonicalBase64(base64)
  if (raw.length > MAX_PRIVATE_KEY_BYTES) throw invalid('The private key is too large')
  if (raw.length < OPENSSH_MAGIC.length) throw invalid('The private key is truncated')
  for (let index = 0; index < OPENSSH_MAGIC.length; index += 1) {
    if (raw[index] !== OPENSSH_MAGIC[index]) throw unsupported('Only OpenSSH-format private keys are supported')
  }

  const reader: FieldReader = { offset: OPENSSH_MAGIC.length }
  const cipher = readText(raw, reader)
  const kdf = readText(raw, reader)
  const kdfOptions = readString(raw, reader)
  const keyCount = readUint32(raw, reader)
  if (keyCount !== 1) throw unsupported('Only single-key OpenSSH files are supported')
  const publicKeyBlob = readString(raw, reader)
  const privateSection = readString(raw, reader)
  if (reader.offset !== raw.length) throw invalid('The private key has trailing data')

  const algorithm = publicKeyAlgorithm(publicKeyBlob)
  const encodedPublicKey = toBase64(publicKeyBlob)
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', publicKeyBlob as BufferSource))
  const fingerprint = `SHA256:${toBase64(digest).replace(/=+$/, '')}`

  const encrypted = cipher !== 'none'
  let plaintext: Uint8Array
  if (encrypted) {
    const keyBytes = CIPHER_KEY_BYTES[cipher]
    if (!keyBytes) throw unsupported(`Unsupported private key cipher "${cipher}"`)
    if (kdf !== 'bcrypt') throw unsupported(`Unsupported private key KDF "${kdf}"`)
    const trimmedPassphrase = typeof passphrase === 'string' ? passphrase : ''
    if (!trimmedPassphrase) {
      throw new OpenSshKeyError('passphrase_required', 'This private key is encrypted; enter its passphrase')
    }
    if (utf8(trimmedPassphrase).byteLength > MAX_PASSPHRASE_BYTES) throw invalid('The passphrase is too long')
    const options: FieldReader = { offset: 0 }
    const salt = readString(kdfOptions, options)
    const rounds = readUint32(kdfOptions, options)
    if (options.offset !== kdfOptions.length) throw invalid('The bcrypt key derivation options are malformed')
    if (!salt.length) throw invalid('The bcrypt salt is empty')
    if (rounds < 1 || rounds > MAX_BCRYPT_ROUNDS) throw unsupported('The bcrypt round count is outside the supported range')
    const derived = await bcryptPbkdf(trimmedPassphrase, salt, keyBytes + 16, rounds)
    plaintext = await decryptPrivateSection(cipher, derived.subarray(0, keyBytes), derived.subarray(keyBytes, keyBytes + 16), privateSection)
  } else {
    if (kdf !== 'none' || kdfOptions.length !== 0) throw invalid('An unencrypted key cannot carry KDF options')
    plaintext = privateSection
  }

  const privateKeyType = readPrivateKeyType(plaintext, encrypted)
  if (privateKeyType !== algorithm) throw invalid('The private and public halves of this key describe different algorithms')

  return {
    algorithm,
    publicKey: `${algorithm} ${encodedPublicKey}`,
    fingerprint,
    encrypted,
    publicKeyBlob,
    privateKeySection: plaintext,
    blockSize: encrypted ? 16 : 8,
  }
}

async function decryptPrivateSection(
  cipher: string,
  keyBytes: Uint8Array,
  iv: Uint8Array,
  ciphertext: Uint8Array,
): Promise<Uint8Array> {
  const counter = cipher.endsWith('-ctr')
  try {
    const key = await crypto.subtle.importKey(
      'raw',
      keyBytes as BufferSource,
      counter ? 'AES-CTR' : 'AES-CBC',
      false,
      ['decrypt'],
    )
    const algorithm = counter
      ? { name: 'AES-CTR', counter: iv as BufferSource, length: 128 }
      : { name: 'AES-CBC', iv: iv as BufferSource }
    return new Uint8Array(await crypto.subtle.decrypt(algorithm, key, ciphertext as BufferSource))
  } catch {
    throw new OpenSshKeyError('passphrase_invalid', 'The passphrase does not decrypt this private key')
  }
}

function readPrivateKeyType(plaintext: Uint8Array, encrypted: boolean): string {
  const reader: FieldReader = { offset: 0 }
  const checkA = readUint32(plaintext, reader)
  const checkB = readUint32(plaintext, reader)
  if (checkA !== checkB) {
    throw new OpenSshKeyError(
      encrypted ? 'passphrase_invalid' : 'invalid',
      encrypted ? 'The passphrase does not decrypt this private key' : 'The private key check integers do not match',
    )
  }
  return readText(plaintext, reader)
}
