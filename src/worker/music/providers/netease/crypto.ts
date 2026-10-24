/**
 * The three wire encodings Netease accepts, reimplemented with the project's own crypto libraries.
 *
 * `weapi` is AES-128-CBC twice with a random per-request key, whose reversed bytes are encrypted with
 * textbook RSA (`m^e mod n`, no padding) into 256 hex characters. `eapi` is one AES-128-ECB pass over a
 * delimited request envelope and answers in uppercase hex. `api` is a plain form post.
 */
import { cbc, ecb } from '@noble/ciphers/aes.js'
import { md5 } from '@noble/hashes/legacy.js'

const encoder = new TextEncoder()
const decoder = new TextDecoder()

export const WEAPI_PRESET_KEY = '0CoJUm6Qyw8W8jud'
export const WEAPI_IV = '0102030405060708'
export const EAPI_KEY = 'e82ckenh8dichen8'
export const EAPI_DELIMITER = '-36cd479b6b5-'

const BASE62 = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'

/**
 * The modulus of the public key the web client ships with. Kept as hex rather than PEM so the
 * exponentiation below does not need an ASN.1 parser; `RSA_EXPONENT` is F4 (65537).
 */
const RSA_MODULUS = BigInt(
  '0xe0b509f6259df8642dbc35662901477df22677ec152b5ff68ace615bb7b725152b3ab17a876aea8a5aa76d2e417629ec4ee341f56135fccf695280104e0312ecbda92557c93870114af6c9d05c4f7f0c3685b7a46bee255932575cce10b424d813cfe4875d3e82047b97ddef52741d546b8e289dc6935b3ece0462db0a22b8e7',
)
const RSA_EXPONENT = 65537n
const RSA_HEX_LENGTH = 256

function utf8(text: string): Uint8Array {
  return encoder.encode(text)
}

export function bytesToHex(bytes: Uint8Array): string {
  let out = ''
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0')
  return out
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

export function md5Hex(text: string): string {
  return bytesToHex(md5(utf8(text)))
}

export function aesCbcEncryptBase64(text: string, key: string, iv: string): string {
  return bytesToBase64(cbc(utf8(key), utf8(iv)).encrypt(utf8(text)))
}

export function aesCbcDecryptUtf8(base64: string, key: string, iv: string): string {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return decoder.decode(cbc(utf8(key), utf8(iv)).decrypt(bytes))
}

export function aesEcbEncryptHex(text: string, key: string): string {
  return bytesToHex(ecb(utf8(key)).encrypt(utf8(text))).toUpperCase()
}

function modPow(base: bigint, exponent: bigint, modulus: bigint): bigint {
  let result = 1n
  let factor = base % modulus
  let power = exponent
  while (power > 0n) {
    if (power & 1n) result = (result * factor) % modulus
    factor = (factor * factor) % modulus
    power >>= 1n
  }
  return result
}

/** Textbook RSA over the UTF-8 bytes of `text`, left-padded to the 1024-bit block width. */
export function rsaEncrypt(text: string): string {
  const message = BigInt(`0x${bytesToHex(utf8(text))}`)
  const encrypted = modPow(message, RSA_EXPONENT, RSA_MODULUS)
  return encrypted.toString(16).padStart(RSA_HEX_LENGTH, '0')
}

function randomSecretKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  let key = ''
  for (const byte of bytes) key += BASE62[byte % BASE62.length]
  return key
}

export interface WeapiPayload {
  params: string
  encSecKey: string
}

/**
 * `secretKey` exists for fixed-vector tests. Production callers leave it out and get a fresh key.
 */
export function weapi(object: Record<string, unknown>, secretKey = randomSecretKey()): WeapiPayload {
  const text = JSON.stringify(object)
  const first = aesCbcEncryptBase64(text, WEAPI_PRESET_KEY, WEAPI_IV)
  const params = aesCbcEncryptBase64(first, secretKey, WEAPI_IV)
  const reversed = secretKey.split('').reverse().join('')
  return { params, encSecKey: rsaEncrypt(reversed) }
}

export interface EapiPayload {
  params: string
}

export function eapi(url: string, object: Record<string, unknown>): EapiPayload {
  const text = JSON.stringify(object)
  const digest = md5Hex(`nobody${url}use${text}md5forencrypt`)
  const data = `${url}${EAPI_DELIMITER}${text}${EAPI_DELIMITER}${digest}`
  return { params: aesEcbEncryptHex(data, EAPI_KEY) }
}

/** `api` mode sends a plain form; objects and arrays are JSON, everything else is stringified. */
export function apiForm(object: Record<string, unknown>): Record<string, string> {
  const form: Record<string, string> = {}
  for (const [key, value] of Object.entries(object)) {
    if (value === undefined || value === null) continue
    form[key] = typeof value === 'object' ? JSON.stringify(value) : String(value)
  }
  return form
}
