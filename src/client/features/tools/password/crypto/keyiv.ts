import { md5 } from '@noble/hashes/legacy.js'
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/ciphers/utils.js'
import { scrypt } from '@noble/hashes/scrypt.js'

export interface KeyIv {
  key: string
  iv: string
}

/** scrypt cost for the vault key: the same N/r/p the login password hash uses. */
const SCRYPT_PARAMS = { N: 2 ** 14, r: 8, p: 1, dkLen: 32 } as const

/**
 * Legacy derivation: three MD5 rounds over the passphrase, IV taken from the third hash.
 *
 * Kept only so rows written before the vault had a salt can still be read. It has no work factor
 * and no salt, which a six-character passphrase cannot compensate for — the only fix is to stop
 * writing with it, which `deriveVaultKey` and the on-unlock upgrade do.
 */
export function getKeyIv(passphrase: string): KeyIv {
  if (typeof passphrase !== 'string') {
    throw new TypeError('Passphrase must be a string')
  }
  const hash1 = bytesToHex(md5(utf8ToBytes(passphrase)))
  const hash2 = bytesToHex(md5(utf8ToBytes(hash1 + passphrase)))
  const hash3 = bytesToHex(md5(utf8ToBytes(hash2 + passphrase)))
  return {
    key: hash2,
    iv: hash3.slice(16),
  }
}

/** 16 random bytes, stored on the vault row and returned to the client on unlock. */
export function createVaultSalt(): string {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  return bytesToHex(salt)
}

/**
 * Key derivation for every vault created or upgraded from now on: scrypt over a per-vault random
 * salt. Two vaults with the same master password then share no key material, and a stolen database
 * costs real work per guess instead of three MD5 calls.
 *
 * `iv` is unused by the sealed envelope; it stays in the shape so a `KeyIV` means the same thing
 * everywhere (and the legacy path can still tell the two derivations apart by its presence).
 */
export function deriveVaultKey(passphrase: string, saltHex: string): KeyIv {
  if (!saltHex) {
    throw new Error('Vault salt is missing')
  }
  const raw = scrypt(utf8ToBytes(passphrase), hexToBytes(saltHex), SCRYPT_PARAMS)
  return { key: bytesToHex(raw), iv: '' }
}
