// @vitest-environment node
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { bcryptPbkdf } from '../src/worker/webssh/bcrypt-pbkdf'

const FIXTURES = fileURLToPath(new URL('./fixtures/webssh/', import.meta.url))
const PASSPHRASE = 'w3-passphrase'

interface Cursor {
  position: number
}

interface ParsedKey {
  cipher: string
  kdf: string
  salt: Uint8Array
  rounds: number
  privateBlob: Uint8Array
}

function pemBody(name: string): Uint8Array {
  const lines = readFileSync(`${FIXTURES}${name}`, 'utf8')
    .split('\n')
    .filter((line) => !line.startsWith('-----'))
  return new Uint8Array(Buffer.from(lines.join(''), 'base64'))
}

function readUint32(bytes: Uint8Array, cursor: Cursor): number {
  const value =
    ((bytes[cursor.position] << 24) |
      (bytes[cursor.position + 1] << 16) |
      (bytes[cursor.position + 2] << 8) |
      bytes[cursor.position + 3]) >>>
    0
  cursor.position += 4
  return value
}

function readString(bytes: Uint8Array, cursor: Cursor): Uint8Array {
  const length = readUint32(bytes, cursor)
  const start = cursor.position
  cursor.position += length
  if (cursor.position > bytes.byteLength) throw new Error('OpenSSH key: truncated string field')
  return bytes.subarray(start, cursor.position)
}

function ascii(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes)
}

function parseOpenSshKey(blob: Uint8Array): ParsedKey {
  if (ascii(blob.subarray(0, 15)) !== 'openssh-key-v1\u0000') throw new Error('OpenSSH key: bad magic')
  const cursor: Cursor = { position: 15 }
  const cipher = ascii(readString(blob, cursor))
  const kdf = ascii(readString(blob, cursor))
  const kdfOptions = readString(blob, cursor)
  const keyCount = readUint32(blob, cursor)
  if (keyCount !== 1) throw new Error(`OpenSSH key: expected 1 key, found ${keyCount}`)
  readString(blob, cursor)
  const privateBlob = readString(blob, cursor)

  let salt: Uint8Array = new Uint8Array(0)
  let rounds = 0
  if (kdf === 'bcrypt') {
    const optionsCursor: Cursor = { position: 0 }
    salt = readString(kdfOptions, optionsCursor)
    rounds = readUint32(kdfOptions, optionsCursor)
  }
  return { cipher, kdf, salt, rounds, privateBlob }
}

async function decryptPrivateSection(key: ParsedKey, passphrase: string): Promise<Uint8Array> {
  if (key.cipher === 'none') return key.privateBlob
  expect(key.cipher).toBe('aes256-ctr')
  const derived = await bcryptPbkdf(passphrase, key.salt, 32 + 16, key.rounds)
  const rawKey = new Uint8Array(derived.subarray(0, 32))
  const iv = new Uint8Array(derived.subarray(32, 48))
  const aesKey = await crypto.subtle.importKey('raw', rawKey, { name: 'AES-CTR' }, false, ['decrypt'])
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-CTR', counter: iv, length: 128 },
    aesKey,
    new Uint8Array(key.privateBlob),
  )
  return new Uint8Array(plain)
}

function checkints(plain: Uint8Array): [number, number] {
  const cursor: Cursor = { position: 0 }
  return [readUint32(plain, cursor), readUint32(plain, cursor)]
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

const fixtures = [
  { name: 'throwaway-ed25519', encrypted: false },
  { name: 'throwaway-ed25519-enc', encrypted: true },
  { name: 'throwaway-rsa-enc', encrypted: true },
]

describe('OpenSSH encrypted private keys', () => {
  for (const fixture of fixtures) {
    it(`validates ${fixture.name} against ssh-keygen's own encryption`, async () => {
      const key = parseOpenSshKey(pemBody(fixture.name))
      if (!fixture.encrypted) {
        expect(key.cipher).toBe('none')
        expect(key.kdf).toBe('none')
        const [first, second] = checkints(key.privateBlob)
        expect(first).toBe(second)
        return
      }

      expect(key.cipher).toBe('aes256-ctr')
      expect(key.kdf).toBe('bcrypt')
      expect(key.salt.byteLength).toBeGreaterThan(0)
      expect(key.rounds).toBeGreaterThanOrEqual(1)

      const good = await decryptPrivateSection(key, PASSPHRASE)
      const [first, second] = checkints(good)
      expect(first).toBe(second)

      const bad = await decryptPrivateSection(key, `${PASSPHRASE}x`)
      const [wrongFirst, wrongSecond] = checkints(bad)
      expect(wrongFirst).not.toBe(wrongSecond)
    })
  }
})

describe('bcryptPbkdf known-answer vector', () => {
  it('derives 32 bytes for password/salt/16 rounds', async () => {
    // The salt is the committed fixture's own bcrypt salt, so the vector stays deterministic.
    const key = parseOpenSshKey(pemBody('throwaway-ed25519-enc'))
    const derived = await bcryptPbkdf('password', key.salt, 32, 16)
    // Produced once by this implementation, whose correctness is established above by
    // ssh-keygen decryption; frozen here so a regression cannot pass silently.
    expect(hex(derived)).toBe('b936ff15674c12b48664ada442bd3f2a38debcc5174a1b696b9af72c90052369')
  })
})
