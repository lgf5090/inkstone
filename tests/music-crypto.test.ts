// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { ecb } from '@noble/ciphers/aes.js'
import {
  EAPI_DELIMITER,
  EAPI_KEY,
  WEAPI_IV,
  WEAPI_PRESET_KEY,
  aesCbcDecryptUtf8,
  aesCbcEncryptBase64,
  aesEcbEncryptHex,
  apiForm,
  bytesToHex,
  eapi,
  md5Hex,
  rsaEncrypt,
  weapi,
} from '../src/worker/music/providers/netease/crypto'

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return bytes
}

const decoder = new TextDecoder()

describe('netease md5', () => {
  it('matches the published RFC 1321 vectors', () => {
    expect(md5Hex('')).toBe('d41d8cd98f00b204e9800998ecf8427e')
    expect(md5Hex('abc')).toBe('900150983cd24fb0d6963f7d28e17f72')
  })
})

describe('netease AES', () => {
  it('round-trips CBC with PKCS7 padding', () => {
    const encrypted = aesCbcEncryptBase64('a short message', WEAPI_PRESET_KEY, WEAPI_IV)
    expect(aesCbcDecryptUtf8(encrypted, WEAPI_PRESET_KEY, WEAPI_IV)).toBe('a short message')
  })

  it('round-trips ECB and emits uppercase hex', () => {
    const encrypted = aesEcbEncryptHex('a short message', EAPI_KEY)
    expect(encrypted).toMatch(/^[0-9A-F]+$/)
    expect(encrypted.length % 32).toBe(0)
    const decrypted = ecb(new TextEncoder().encode(EAPI_KEY)).decrypt(hexToBytes(encrypted))
    expect(decoder.decode(decrypted)).toBe('a short message')
  })
})

describe('netease weapi', () => {
  it('produces the fixed vector for an injected secret key', () => {
    expect(weapi({ a: 1 }, 'abcdefghijklmnop').params).toBe(
      'Ho/4Pu1bYyrzwcnXPnTcXm1Gb04eSzwGSNb4NI3YqZY=',
    )
  })

  it('encrypts twice and reverses the secret key into the RSA block', () => {
    const secret = 'abcdefghijklmnop'
    const payload = weapi({ hello: 'world' }, secret)
    const inner = aesCbcDecryptUtf8(payload.params, secret, WEAPI_IV)
    const plain = aesCbcDecryptUtf8(inner, WEAPI_PRESET_KEY, WEAPI_IV)
    expect(JSON.parse(plain)).toEqual({ hello: 'world' })
    expect(payload.encSecKey).toBe(rsaEncrypt(secret.split('').reverse().join('')))
  })
})

describe('netease RSA', () => {
  it('pads to 256 hex characters and is deterministic', () => {
    const first = rsaEncrypt('abcdefghijklmnop')
    const second = rsaEncrypt('abcdefghijklmnop')
    expect(first).toHaveLength(256)
    expect(first).toMatch(/^[0-9a-f]{256}$/)
    expect(second).toBe(first)
    expect(BigInt(`0x${first}`)).toBeGreaterThan(0n)
    expect(rsaEncrypt('ponmlkjihgfedcba')).not.toBe(first)
  })
})

describe('netease eapi', () => {
  it('matches the fixed ECB vector', () => {
    expect(eapi('/api/test', { a: 1 }).params).toBe(
      '4DC723619A991588865191FD2F319BAD0918BC9C604E1E84A5C3578922E3A7E8810405B5500AF5BEABA2DEAB687471586CE47DE62C9D523E260A0250C7F3AC2802B572BD7B95623F10A1D55EF99B9A8C',
    )
  })

  it('wraps the URL, body and digest in the delimited envelope', () => {
    const payload = eapi('/api/test', { a: 1 })
    const plain = decoder.decode(ecb(new TextEncoder().encode(EAPI_KEY)).decrypt(hexToBytes(payload.params)))
    expect(plain.startsWith(`/api/test${EAPI_DELIMITER}{"a":1}${EAPI_DELIMITER}`)).toBe(true)
    expect(plain.endsWith(md5Hex(`nobody/api/testuse{"a":1}md5forencrypt`))).toBe(true)
  })
})

describe('netease api form', () => {
  it('keeps scalars, drops undefined, and serializes structured values', () => {
    expect(apiForm({ a: 1, b: 'two', c: true, d: undefined, e: [1, 2] })).toEqual({
      a: '1',
      b: 'two',
      c: 'true',
      e: '[1,2]',
    })
    expect(bytesToHex(new Uint8Array([0, 15, 255]))).toBe('000fff')
  })
})
