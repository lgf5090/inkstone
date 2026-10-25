import { cbc } from '@noble/ciphers/aes.js'
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/ciphers/utils.js'
import { getKeyIv, type KeyIv } from './keyiv'

export const RECOVERY_PASSPHRASE = 'recovery_key'

export function encryptValue(keyiv: KeyIv, plaintext: string): string {
  if (!plaintext) {
    return ''
  }
  const keyBytes = utf8ToBytes(keyiv.key)
  const ivBytes = utf8ToBytes(keyiv.iv)
  const cipher = cbc(keyBytes, ivBytes)
  const encrypted = cipher.encrypt(utf8ToBytes(plaintext))
  return bytesToHex(encrypted)
}

export function decryptValue(keyiv: KeyIv, ciphertext: string): string {
  if (!ciphertext) {
    return ''
  }
  try {
    const keyBytes = utf8ToBytes(keyiv.key)
    const ivBytes = utf8ToBytes(keyiv.iv)
    const cipher = cbc(keyBytes, ivBytes)
    const decrypted = cipher.decrypt(hexToBytes(ciphertext))
    return new TextDecoder().decode(decrypted)
  } catch (error) {
    throw new Error(
      `Failed to decrypt ciphertext: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    )
  }
}

export function getRecoveryPass(password: string): string {
  if (!password) {
    return ''
  }
  const keyiv = getKeyIv(RECOVERY_PASSPHRASE)
  return encryptValue(keyiv, password)
}

export function getOriginalPasswordPlus(recoveryHex: string): string {
  if (!recoveryHex) {
    return ''
  }
  const keyiv = getKeyIv(RECOVERY_PASSPHRASE)
  return decryptValue(keyiv, recoveryHex)
}
