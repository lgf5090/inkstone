// @vitest-environment node
// W1 cipher, MAC, key derivation and key-exchange vectors.

import { describe, expect, it } from 'vitest'
import { SSHAESCTRCipher, SSHAESGCMCipher, SSHHMAC } from '../src/worker/webssh/ssh/crypto'
import { KeyDerivation } from '../src/worker/webssh/ssh/keys'
import { Curve25519KeyExchange } from '../src/worker/webssh/ssh/kex-curve25519'
import { ECDHKeyExchange } from '../src/worker/webssh/ssh/kex-ecdh'
import { concat, toBufferSource } from '../src/worker/webssh/ssh/utils'

const encoder = new TextEncoder()

describe('AES-GCM packet cipher', () => {
  const key = new Uint8Array(16).fill(7)
  const iv = new Uint8Array(12).fill(3)

  it('encrypts with authentication and decrypts with a fresh instance', async () => {
    const encryptor = new SSHAESGCMCipher(key, iv)
    await encryptor.init()
    const plaintext = encoder.encode('ssh-gcm-payload')
    const ciphertext = await encryptor.encrypt(plaintext)
    expect(ciphertext.length).toBe(plaintext.length + 16)

    const decryptor = new SSHAESGCMCipher(key, iv)
    await decryptor.init()
    expect(await decryptor.decrypt(ciphertext)).toEqual(plaintext)
  })

  it('rejects a tampered tag', async () => {
    const encryptor = new SSHAESGCMCipher(key, iv)
    await encryptor.init()
    const ciphertext = await encryptor.encrypt(encoder.encode('tamper-me'))
    ciphertext[ciphertext.length - 1] ^= 0xff
    const decryptor = new SSHAESGCMCipher(key, iv)
    await decryptor.init()
    expect(await decryptor.decrypt(ciphertext)).toBeNull()
  })

  it('uses the packet length as AAD', async () => {
    const aad = new Uint8Array([0, 0, 0, 20])
    const encryptor = new SSHAESGCMCipher(key, iv)
    await encryptor.init()
    const ciphertext = await encryptor.encrypt(encoder.encode('aad'), 0, aad)

    const decryptor = new SSHAESGCMCipher(key, iv)
    await decryptor.init()
    expect(await decryptor.decrypt(ciphertext, 0, aad)).toEqual(encoder.encode('aad'))

    const wrongAadDecryptor = new SSHAESGCMCipher(key, iv)
    await wrongAadDecryptor.init()
    expect(await wrongAadDecryptor.decrypt(ciphertext, 0, new Uint8Array([0, 0, 0, 21]))).toBeNull()
  })

  it('requires a 12-byte IV', () => {
    expect(() => new SSHAESGCMCipher(key, new Uint8Array(16))).toThrow('12-byte IV')
  })
})

describe('AES-CTR packet cipher', () => {
  const key = new Uint8Array(32).fill(9)
  const iv = new Uint8Array(16).fill(5)

  it('encrypts and decrypts with a fresh instance', async () => {
    const encryptor = new SSHAESCTRCipher(key, iv)
    await encryptor.init()
    const plaintext = encoder.encode('ssh-ctr-payload-with-more-than-one-block')
    const ciphertext = await encryptor.encrypt(plaintext)

    const decryptor = new SSHAESCTRCipher(key, iv)
    await decryptor.init()
    expect(await decryptor.decrypt(ciphertext)).toEqual(plaintext)
  })

  it('requires a 16-byte IV', () => {
    expect(() => new SSHAESCTRCipher(key, new Uint8Array(12))).toThrow('16-byte IV')
  })
})

describe('HMAC', () => {
  const key = new Uint8Array(32).fill(1)

  it('signs and verifies the sequence number plus packet', async () => {
    const signer = new SSHHMAC('hmac-sha2-256', key)
    await signer.init()
    const packet = encoder.encode('packet-body')
    const signature = await signer.sign(packet, 42)
    expect(signature.length).toBe(32)

    const verifier = new SSHHMAC('hmac-sha2-256', key)
    await verifier.init()
    expect(await verifier.verify(packet, 42, signature)).toBe(true)
    expect(await verifier.verify(packet, 43, signature)).toBe(false)
  })

  it('supports SHA-512 output lengths', async () => {
    const signer = new SSHHMAC('hmac-sha2-512', new Uint8Array(64).fill(2))
    await signer.init()
    const signature = await signer.sign(encoder.encode('x'), 0)
    expect(signature.length).toBe(64)
  })

  it('rejects an unsupported MAC name', () => {
    expect(() => new SSHHMAC('hmac-md5', new Uint8Array(16))).toThrow('Unsupported MAC algorithm')
  })
})

describe('Key derivation', () => {
  const sharedSecret = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7])
  const exchangeHash = new Uint8Array(32).fill(0xaa)
  const sessionId = new Uint8Array(32).fill(0xbb)

  it('matches the RFC 4253 expansion formula for the first block', async () => {
    const expected = new Uint8Array(
      await crypto.subtle.digest('SHA-256', toBufferSource(concat(sharedSecret, exchangeHash, encoder.encode('A'), sessionId))),
    )
    const keys = await KeyDerivation.deriveKeys(sharedSecret, exchangeHash, sessionId, 12, 12, 32, 32, 16, 16)
    expect(keys.ivClientToServer).toEqual(expected.slice(0, 12))
  })

  it('truncates each direction to the requested key length', async () => {
    const keys = await KeyDerivation.deriveKeys(sharedSecret, exchangeHash, sessionId, 12, 12, 32, 32, 16, 24)
    expect(keys.encKeyClientToServer.length).toBe(16)
    expect(keys.encKeyServerToClient.length).toBe(24)
    expect(keys.integrityKeyC2S.length).toBe(32)
    expect(keys.sessionID).toEqual(sessionId)
    expect(keys.ivClientToServer).not.toEqual(keys.ivServerToClient)
  })

  it('depends on the exchange hash and session id', async () => {
    const first = await KeyDerivation.deriveKeys(sharedSecret, exchangeHash, sessionId, 12, 12, 32, 32, 16, 16)
    const otherHash = await KeyDerivation.deriveKeys(sharedSecret, new Uint8Array(32).fill(0xcc), sessionId, 12, 12, 32, 32, 16, 16)
    expect(first.ivClientToServer).not.toEqual(otherHash.ivClientToServer)
  })
})

describe('Key exchange primitives', () => {
  it('agrees on a Curve25519 shared secret in both directions', async () => {
    const client = await Curve25519KeyExchange.generateKeyPair()
    const server = await Curve25519KeyExchange.generateKeyPair()
    const clientPublic = await Curve25519KeyExchange.exportRawPublicKey(client)
    const serverPublic = await Curve25519KeyExchange.exportRawPublicKey(server)
    expect(clientPublic.length).toBe(32)

    const fromClient = await Curve25519KeyExchange.computeSharedSecret(client.privateKey, serverPublic)
    const fromServer = await Curve25519KeyExchange.computeSharedSecret(server.privateKey, clientPublic)
    expect(fromClient).toEqual(fromServer)
  })

  it('agrees on an ECDH P-256 shared secret in both directions', async () => {
    const client = await ECDHKeyExchange.generateKeyPair()
    const server = await ECDHKeyExchange.generateKeyPair()
    const clientPublic = await ECDHKeyExchange.exportRawPublicKey(client)
    const serverPublic = await ECDHKeyExchange.exportRawPublicKey(server)

    const fromClient = await ECDHKeyExchange.computeSharedSecret(client.privateKey, serverPublic)
    const fromServer = await ECDHKeyExchange.computeSharedSecret(server.privateKey, clientPublic)
    expect(fromClient).toEqual(fromServer)
  })

  it('computes a deterministic 32-byte exchange hash bound to the host key', async () => {
    const hostKey = new Uint8Array([1, 2, 3, 4])
    const clientPublic = new Uint8Array(32).fill(1)
    const serverPublic = new Uint8Array(32).fill(2)
    const sharedSecret = new Uint8Array([0, 9, 8, 7])

    const first = await Curve25519KeyExchange.computeExchangeHash(
      'SSH-2.0-client', 'SSH-2.0-server', new Uint8Array([20, 1]), new Uint8Array([20, 2]),
      hostKey, clientPublic, serverPublic, sharedSecret,
    )
    const second = await Curve25519KeyExchange.computeExchangeHash(
      'SSH-2.0-client', 'SSH-2.0-server', new Uint8Array([20, 1]), new Uint8Array([20, 2]),
      hostKey, clientPublic, serverPublic, sharedSecret,
    )
    const other = await Curve25519KeyExchange.computeExchangeHash(
      'SSH-2.0-client', 'SSH-2.0-server', new Uint8Array([20, 1]), new Uint8Array([20, 2]),
      new Uint8Array([1, 2, 3, 5]), clientPublic, serverPublic, sharedSecret,
    )
    expect(first.length).toBe(32)
    expect(first).toEqual(second)
    expect(first).not.toEqual(other)
  })
})
