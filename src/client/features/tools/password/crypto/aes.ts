import { cbc, gcm } from '@noble/ciphers/aes.js'
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/ciphers/utils.js'
import type { KeyIv } from './keyiv'

/**
 * Sealed values carry a version prefix so a reader can tell them from the rows written before this
 * format existed. `<prefix><hex(nonce || ciphertext || tag)>`.
 */
export const SEALED_PREFIX = 'v2.'
/**
 * v3 adds associated data: the account id and field name. A ciphertext moved to another row then
 * fails authentication instead of decrypting into the wrong account.
 */
export const SEALED_PREFIX_V3 = 'v3.'

const NONCE_BYTES = 12

/**
 * Legacy keys are 32 characters of MD5 hex used as UTF-8 bytes (32 bytes). Derived keys are 64 hex
 * characters standing for 32 raw bytes. The length is the discriminator, and it is stable: nothing
 * else ever produced a `KeyIv`.
 */
function rawKey(keyiv: KeyIv): Uint8Array {
  return keyiv.key.length === 64 ? hexToBytes(keyiv.key) : utf8ToBytes(keyiv.key)
}

function aadBytes(aad: string | undefined): Uint8Array | undefined {
  return aad === undefined ? undefined : utf8ToBytes(aad)
}

/**
 * AES-256-GCM with a fresh random nonce per value. GCM authenticates, so a wrong key or a tampered
 * row fails loudly instead of decrypting to garbage — the old CBC mode let about one wrong master
 * password in 271 through its padding check, which then unlocked a vault of nonsense.
 *
 * Passing `aad` writes the v3 envelope, which binds the value to the row and column it belongs to.
 */
export function encryptValue(keyiv: KeyIv, plaintext: string, aad?: string): string {
  if (!plaintext) {
    return ''
  }
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES))
  const sealed = gcm(rawKey(keyiv), nonce, aadBytes(aad)).encrypt(utf8ToBytes(plaintext))
  const packed = new Uint8Array(nonce.length + sealed.length)
  packed.set(nonce, 0)
  packed.set(sealed, nonce.length)
  return (aad === undefined ? SEALED_PREFIX : SEALED_PREFIX_V3) + bytesToHex(packed)
}

export function decryptValue(keyiv: KeyIv, ciphertext: string, aad?: string): string {
  if (!ciphertext) {
    return ''
  }

  try {
    if (ciphertext.startsWith(SEALED_PREFIX_V3)) {
      if (aad === undefined) {
        throw new Error('v3 ciphertext needs its account id and field name')
      }
      const packed = hexToBytes(ciphertext.slice(SEALED_PREFIX_V3.length))
      const nonce = packed.subarray(0, NONCE_BYTES)
      const sealed = packed.subarray(NONCE_BYTES)
      return new TextDecoder().decode(gcm(rawKey(keyiv), nonce, aadBytes(aad)).decrypt(sealed))
    }
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
