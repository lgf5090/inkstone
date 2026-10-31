import { cbc, gcm } from '@noble/ciphers/aes.js'
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/ciphers/utils.js'
import type { KeyIv } from './keyiv'

/**
 * Sealed values carry a version prefix so a reader can tell them from the rows written before this
 * format existed. `<prefix><hex(nonce || ciphertext || tag)>`.
 */
export const SEALED_PREFIX = 'v2.'

const NONCE_BYTES = 12

/**
 * Legacy keys are 32 characters of MD5 hex used as UTF-8 bytes (32 bytes). Derived keys are 64 hex
 * characters standing for 32 raw bytes. The length is the discriminator, and it is stable: nothing
 * else ever produced a `KeyIv`.
 */
function rawKey(keyiv: KeyIv): Uint8Array {
  return keyiv.key.length === 64 ? hexToBytes(keyiv.key) : utf8ToBytes(keyiv.key)
}

/**
 * AES-256-GCM with a fresh random nonce per value. GCM authenticates, so a wrong key or a tampered
 * row fails loudly instead of decrypting to garbage — the old CBC mode let about one wrong master
 * password in 271 through its padding check, which then unlocked a vault of nonsense.
 */
export function encryptValue(keyiv: KeyIv, plaintext: string): string {
  if (!plaintext) {
    return ''
  }
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES))
  const sealed = gcm(rawKey(keyiv), nonce).encrypt(utf8ToBytes(plaintext))
  const packed = new Uint8Array(nonce.length + sealed.length)
  packed.set(nonce, 0)
  packed.set(sealed, nonce.length)
  return SEALED_PREFIX + bytesToHex(packed)
}

export function decryptValue(keyiv: KeyIv, ciphertext: string): string {
  if (!ciphertext) {
    return ''
  }

  try {
    if (ciphertext.startsWith(SEALED_PREFIX)) {
      const packed = hexToBytes(ciphertext.slice(SEALED_PREFIX.length))
      const nonce = packed.subarray(0, NONCE_BYTES)
      const sealed = packed.subarray(NONCE_BYTES)
      return new TextDecoder().decode(gcm(rawKey(keyiv), nonce).decrypt(sealed))
    }

    // Rows written before the envelope: deterministic AES-CBC under the MD5-derived key. Only the
    // legacy derivation carries an IV, so a derived key reaching this branch fails rather than
    // silently "succeeding" on the wrong data.
    const cipher = cbc(utf8ToBytes(keyiv.key), utf8ToBytes(keyiv.iv))
    return new TextDecoder().decode(cipher.decrypt(hexToBytes(ciphertext)))
  } catch (error) {
    throw new Error(
      `Failed to decrypt ciphertext: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    )
  }
}
