import { md5 } from '@noble/hashes/legacy.js'
import { bytesToHex, utf8ToBytes } from '@noble/ciphers/utils.js'

export interface KeyIv {
  key: string
  iv: string
}

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
