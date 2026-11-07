// @vitest-environment node
// W1 authentication: OpenSSH key parsing, request construction, signature self-verification and
// keyboard-interactive prompt handling. The fixtures are throwaway keys generated for this suite.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { SSHAuth } from '../src/worker/webssh/ssh/auth'
import {
  buildKeyboardInteractiveResponse,
  buildPasswordAuthRequest,
  isSupportedPasswordPrompt,
  parseKeyboardInteractiveChallenge,
  passwordResponsesForChallenge,
} from '../src/worker/webssh/ssh/auth-password'
import { concat, encodeString, readUint32, toBufferSource, writeUint32 } from '../src/worker/webssh/ssh/utils'

const KEY_FILES = {
  ed25519: 'id_ed25519',
  rsa: 'id_rsa',
  ecdsa: 'id_ecdsa',
} as const

function readKey(name: string): string {
  return readFileSync(fileURLToPath(new URL(`./fixtures/webssh/${name}`, import.meta.url)), 'utf8')
}

interface Field {
  bytes: Uint8Array
  next: number
}

function readField(data: Uint8Array, offset: number): Field {
  const length = readUint32(data, offset)
  const start = offset + 4
  return { bytes: data.subarray(start, start + length), next: start + length }
}

function readString(data: Uint8Array, offset: number): { value: string; next: number } {
  const field = readField(data, offset)
  return { value: new TextDecoder().decode(field.bytes), next: field.next }
}

function base64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url')
}

function trimMPInt(bytes: Uint8Array): Uint8Array {
  let start = 0
  while (start < bytes.length - 1 && bytes[start] === 0) start++
  return bytes.subarray(start)
}

function padFixed(bytes: Uint8Array, size: number): Uint8Array {
  const result = new Uint8Array(size)
  result.set(trimMPInt(bytes), size - trimMPInt(bytes).length)
  return result
}

describe('OpenSSH private key parsing', () => {
  const fingerprints = {
    ed25519: 'SHA256:3th+S2pWw1lPHY/+cSOe5aSXgyzs2YkdY/bnAfki5sE',
    rsa: 'SHA256:smYsb6uNdICOnnUzwUhXk8sSmWtBL9nki9mtfri83uQ',
    ecdsa: 'SHA256:wEhAVoeoH7O2XlIJ7uvF4EaFEOYsBJzmt6PYIhoAGpU',
  }

  it.each([
    ['ed25519', 'ssh-ed25519'],
    ['rsa', 'ssh-rsa'],
    ['ecdsa', 'ecdsa-sha2-nistp256'],
  ] as const)('extracts the %s public key and fingerprint', async (kind, keyType) => {
    const info = await SSHAuth.publicKeyInfo(readKey(KEY_FILES[kind]))
    expect(info.publicKey.startsWith(`${keyType} `)).toBe(true)
    expect(info.fingerprint).toBe(fingerprints[kind])
  })

  it('rejects a non-OpenSSH key format', async () => {
    const pkcs8 = '-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----'
    await expect(SSHAuth.publicKeyInfo(pkcs8)).rejects.toThrow('Only OpenSSH-format private keys are supported')
  })

  it('requires the passphrase for an encrypted key and rejects a wrong one', async () => {
    const pem = readKey('throwaway-ed25519-enc')
    await expect(SSHAuth.publicKeyInfo(pem)).rejects.toThrow('This private key is encrypted; enter its passphrase')
    await expect(SSHAuth.publicKeyInfo(pem, 'wrong-passphrase')).rejects.toThrow('The passphrase does not decrypt this private key')
  })

  it('extracts the public key of an encrypted key with its passphrase', async () => {
    const info = await SSHAuth.publicKeyInfo(readKey('throwaway-ed25519-enc'), 'w3-passphrase')
    expect(info.publicKey.startsWith('ssh-ed25519 ')).toBe(true)
    expect(info.fingerprint).toBe('SHA256:DKCSOm3f7YTyX2lAUeATITlkGpl6EeYQGAktWz2nNj8')
  })

  it('rejects a corrupted check integer pair', async () => {
    const key = readKey(KEY_FILES.ed25519)
    const binary = Buffer.from(key.split('\n').filter((line) => !line.startsWith('-----')).join(''), 'base64')
    const magicLength = 'openssh-key-v1\u0000'.length
    let offset = magicLength
    for (let index = 0; index < 3; index++) {
      const length = readUint32(binary, offset)
      offset += 4 + length
    }
    offset += 4 // number of keys
    const publicSectionLength = readUint32(binary, offset)
    offset += 4 + publicSectionLength
    offset += 4 // private section length
    binary[offset + 3] ^= 0x01
    const body = Buffer.from(binary).toString('base64').match(/.{1,70}/g)?.join('\n') ?? ''
    const pem = `-----BEGIN OPENSSH PRIVATE KEY-----\n${body}\n-----END OPENSSH PRIVATE KEY-----`
    await expect(SSHAuth.publicKeyInfo(pem)).rejects.toThrow('The private key check integers do not match')
  })
})

describe('public-key authentication request', () => {
  const sessionId = new Uint8Array(32).fill(0x5a)

  async function buildAndSplit(kind: keyof typeof KEY_FILES) {
    const request = await SSHAuth.buildPublicKeyAuthRequest('testuser', readKey(KEY_FILES[kind]), sessionId)
    expect(request[0]).toBe(50)
    const username = readString(request, 1)
    expect(username.value).toBe('testuser')
    const service = readString(request, username.next)
    expect(service.value).toBe('ssh-connection')
    const method = readString(request, service.next)
    expect(method.value).toBe('publickey')
    const hasSignature = request[method.next]
    expect(hasSignature).toBe(1)
    const algorithm = readString(request, method.next + 1)
    const publicKey = readField(request, algorithm.next)
    const signatureStart = publicKey.next
    const signature = readField(request, signatureStart)
    expect(signature.next).toBe(request.length)

    const requestBody = request.subarray(0, signatureStart)
    const dataToSign = concat(encodeString(sessionId), requestBody)
    const signatureType = readString(signature.bytes, 0)
    const signatureValue = readField(signature.bytes, signatureType.next)
    return { algorithm: algorithm.value, publicKey: publicKey.bytes, dataToSign, signatureType: signatureType.value, signatureValue: signatureValue.bytes }
  }

  it('signs an Ed25519 request the public key can verify', async () => {
    const parts = await buildAndSplit('ed25519')
    expect(parts.algorithm).toBe('ssh-ed25519')
    expect(parts.signatureType).toBe('ssh-ed25519')

    const blobType = readString(parts.publicKey, 0)
    expect(blobType.value).toBe('ssh-ed25519')
    const rawKey = readField(parts.publicKey, blobType.next)
    const key = await crypto.subtle.importKey('raw', toBufferSource(rawKey.bytes), { name: 'Ed25519' }, false, ['verify'])
    expect(await crypto.subtle.verify('Ed25519', key, toBufferSource(parts.signatureValue), toBufferSource(parts.dataToSign))).toBe(true)
  })

  it('signs an encrypted Ed25519 request when the passphrase is supplied', async () => {
    const request = await SSHAuth.buildPublicKeyAuthRequest(
      'testuser',
      readKey('throwaway-ed25519-enc'),
      sessionId,
      undefined,
      'w3-passphrase',
    )
    expect(request[0]).toBe(50)
    const username = readString(request, 1)
    const service = readString(request, username.next)
    const method = readString(request, service.next)
    const algorithm = readString(request, method.next + 1)
    expect(algorithm.value).toBe('ssh-ed25519')
    const publicKey = readField(request, algorithm.next)
    const signature = readField(request, publicKey.next)
    const requestBody = request.subarray(0, publicKey.next)
    const dataToSign = concat(encodeString(sessionId), requestBody)
    const blobType = readString(publicKey.bytes, 0)
    const rawKey = readField(publicKey.bytes, blobType.next)
    const key = await crypto.subtle.importKey('raw', toBufferSource(rawKey.bytes), { name: 'Ed25519' }, false, ['verify'])
    const signatureType = readString(signature.bytes, 0)
    const signatureValue = readField(signature.bytes, signatureType.next)
    expect(signatureType.value).toBe('ssh-ed25519')
    expect(await crypto.subtle.verify(
      'Ed25519',
      key,
      toBufferSource(signatureValue.bytes),
      toBufferSource(dataToSign),
    )).toBe(true)
  })

  it('signs an RSA request with rsa-sha2-256', async () => {
    const parts = await buildAndSplit('rsa')
    expect(parts.algorithm).toBe('rsa-sha2-256')
    expect(parts.signatureType).toBe('rsa-sha2-256')

    const type = readString(parts.publicKey, 0)
    const exponent = readField(parts.publicKey, type.next)
    const modulus = readField(parts.publicKey, exponent.next)
    const key = await crypto.subtle.importKey(
      'jwk',
      { kty: 'RSA', n: base64Url(trimMPInt(modulus.bytes)), e: base64Url(trimMPInt(exponent.bytes)), ext: true },
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify'],
    )
    expect(await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5',
      key,
      toBufferSource(parts.signatureValue),
      toBufferSource(parts.dataToSign),
    )).toBe(true)
  })

  it('signs an ECDSA P-256 request the public key can verify', async () => {
    const parts = await buildAndSplit('ecdsa')
    expect(parts.algorithm).toBe('ecdsa-sha2-nistp256')
    expect(parts.signatureType).toBe('ecdsa-sha2-nistp256')

    const type = readString(parts.publicKey, 0)
    const curve = readString(parts.publicKey, type.next)
    expect(curve.value).toBe('nistp256')
    const point = readField(parts.publicKey, curve.next)
    const key = await crypto.subtle.importKey('raw', toBufferSource(point.bytes), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'])

    const r = readField(parts.signatureValue, 0)
    const s = readField(parts.signatureValue, r.next)
    const rawSignature = concat(padFixed(r.bytes, 32), padFixed(s.bytes, 32))
    expect(await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      key,
      toBufferSource(rawSignature),
      toBufferSource(parts.dataToSign),
    )).toBe(true)
  })

  it('prefers the server-advertised RSA signature algorithm', async () => {
    const request = await SSHAuth.buildPublicKeyAuthRequest(
      'testuser',
      readKey(KEY_FILES.rsa),
      sessionId,
      ['rsa-sha2-512', 'rsa-sha2-256'],
    )
    const username = readString(request, 1)
    const service = readString(request, username.next)
    const method = readString(request, service.next)
    const algorithm = readString(request, method.next + 1)
    expect(algorithm.value).toBe('rsa-sha2-512')
  })

  it('rejects a server that offers no usable RSA signature algorithm', async () => {
    await expect(SSHAuth.buildPublicKeyAuthRequest(
      'testuser',
      readKey(KEY_FILES.rsa),
      sessionId,
      ['ssh-rsa'],
    )).rejects.toThrow('no_supported_rsa_signature_algorithm')
  })
})

describe('password and keyboard-interactive requests', () => {
  it('builds a password request with the RFC 4252 fields', () => {
    const request = buildPasswordAuthRequest('alice', 's3cret')
    expect(request[0]).toBe(50)
    const username = readString(request, 1)
    expect(username.value).toBe('alice')
    const service = readString(request, username.next)
    expect(service.value).toBe('ssh-connection')
    const method = readString(request, service.next)
    expect(method.value).toBe('password')
    expect(request[method.next]).toBe(0)
    const password = readString(request, method.next + 1)
    expect(password.value).toBe('s3cret')
  })

  function challengePayload(input: {
    name?: string
    instruction?: string
    prompts: Array<{ text: string; echo: boolean }>
  }): Uint8Array {
    const count = new Uint8Array(4)
    writeUint32(count, 0, input.prompts.length)
    const parts = [
      new Uint8Array([60]),
      encodeString(input.name ?? ''),
      encodeString(input.instruction ?? ''),
      encodeString('en-US'),
      count,
    ]
    for (const prompt of input.prompts) {
      parts.push(encodeString(prompt.text))
      parts.push(new Uint8Array([prompt.echo ? 1 : 0]))
    }
    return concat(...parts)
  }

  it('parses a keyboard-interactive challenge', () => {
    const parsed = parseKeyboardInteractiveChallenge(challengePayload({
      prompts: [{ text: 'Password: ', echo: false }],
    }))
    expect(parsed.prompts).toEqual([{ text: 'Password: ', echo: false }])
    expect(parsed.language).toBe('en-US')
  })

  it('answers only an unambiguous password prompt', () => {
    const paragraph = parseKeyboardInteractiveChallenge(challengePayload({
      prompts: [{ text: 'Password: ', echo: false }],
    }))
    const identity = { username: 'alice', host: 'example.com' }
    expect(isSupportedPasswordPrompt(paragraph, identity)).toBe(true)
    expect(passwordResponsesForChallenge(paragraph, 'pw', identity)).toEqual(['pw'])

    const withContext = parseKeyboardInteractiveChallenge(challengePayload({
      instruction: 'Please authenticate',
      prompts: [{ text: 'Password: ', echo: false }],
    }))
    expect(isSupportedPasswordPrompt(withContext, identity)).toBe(false)

    const targeted = parseKeyboardInteractiveChallenge(challengePayload({
      prompts: [{ text: 'Password for alice@example.com:', echo: false }],
    }))
    expect(isSupportedPasswordPrompt(targeted, identity)).toBe(true)
    expect(isSupportedPasswordPrompt(targeted, { username: 'bob', host: 'example.com' })).toBe(false)
  })

  it('rejects a multi-prompt or echoing challenge', () => {
    const multi = parseKeyboardInteractiveChallenge(challengePayload({
      prompts: [{ text: 'User: ', echo: true }, { text: 'Password: ', echo: false }],
    }))
    expect(() => passwordResponsesForChallenge(multi, 'pw', { username: 'alice', host: 'h' })).toThrow('not a supported password prompt')
  })

  it('builds an info response with the response count', () => {
    const response = buildKeyboardInteractiveResponse(['one', 'two'])
    expect(response[0]).toBe(61)
    expect(readUint32(response, 1)).toBe(2)
    const first = readString(response, 5)
    expect(first.value).toBe('one')
    const second = readString(response, first.next)
    expect(second.value).toBe('two')
  })

  it('rejects a malformed challenge with trailing data', () => {
    const payload = challengePayload({ prompts: [{ text: 'Password: ', echo: false }] })
    const trailing = new Uint8Array(payload.length + 1)
    trailing.set(payload)
    expect(() => parseKeyboardInteractiveChallenge(trailing)).toThrow('Malformed SSH keyboard-interactive trailing data')
  })
})
