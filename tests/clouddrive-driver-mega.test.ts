// @vitest-environment node
import { ctr, ecb } from '@noble/ciphers/aes.js'
import { pbkdf2 } from '@noble/hashes/pbkdf2.js'
import { sha512 } from '@noble/hashes/sha2.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMegaDriver } from '../src/worker/clouddrive/drivers/mega'
import { DriverError, type DriverContext } from '../src/worker/clouddrive/drivers/contract'

const EMAIL = 'owner@example.com'
const PASSWORD = 'mega-test-password'
const USER_HANDLE = 'USERHANDLE'
const SALT = Uint8Array.from({ length: 16 }, (_, index) => index)
const MASTER_KEY = Uint8Array.from({ length: 16 }, (_, index) => 16 + index)
const ROOT_KEY = Uint8Array.from({ length: 16 }, (_, index) => 32 + index)
const DOCS_KEY = Uint8Array.from({ length: 16 }, (_, index) => 48 + index)
const FILE_A_STORED = Uint8Array.from({ length: 32 }, (_, index) => 64 + index)
const FILE_B_STORED = Uint8Array.from({ length: 32 }, (_, index) => 96 + index)
const FILE_C_STORED = Uint8Array.from({ length: 32 }, (_, index) => 128 + index)

// A fixed 1024-bit RSA key, in the four-MPI layout MEGA stores (p, q, d, u = p^-1 mod q).
const P = 0xf60cfa37b29ec4b17d197bee264b367010f81d4b5b6cffa1a7f185630caa03bad762e9e83aa02313a59fd35850db8dd37a1a8dcca99097243314d788c5a60267n
const Q = 0xd471a4f82a054f8ede5e07feb14d0a98ecc2fe794fe2cc299a598adf3b1129dee34f8239090d78fbfb442c7207cc5d3eedcd4bde4fcac2074d655bd250830a5dn
const D = 0x0e0f8badd3565ae75a735f2f2ca7b265f1eb39635f9f1afcbbc0c3edc806b2b2256f99c30e01243f519ec40246df6510a25a89ed17833cc429dfee23b89cdd6bdaaf7771f8fb3c9217bb068a63ecedf5a4f0e05e11b8dc957b6594c8fe70251ba5c1a18fc1c354072be826fa1b30825cf50d7eded7152b44f24c2e6a0c7469a9n
const E = 65537n
const N = P * Q

function modInverse(value: bigint, modulus: bigint): bigint {
  let oldR = value % modulus
  let r = modulus
  let oldS = 1n
  let s = 0n
  while (r !== 0n) {
    const quotient = oldR / r
    ;[oldR, r] = [r, oldR - quotient * r]
    ;[oldS, s] = [s, oldS - quotient * s]
  }
  return ((oldS % modulus) + modulus) % modulus
}

function toBytes(value: bigint): Uint8Array {
  let hex = value.toString(16)
  if (hex.length % 2) hex = `0${hex}`
  const out = new Uint8Array(hex.length / 2)
  for (let index = 0; index < out.length; index++) out[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16)
  return out
}

function fromBytes(bytes: Uint8Array): bigint {
  let hex = '0x0'
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0')
  return BigInt(hex)
}

function modPow(base: bigint, exponent: bigint, modulus: bigint): bigint {
  let result = 1n
  let current = base % modulus
  let power = exponent
  while (power > 0n) {
    if (power & 1n) result = (result * current) % modulus
    current = (current * current) % modulus
    power >>= 1n
  }
  return result
}

const BASE64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

function base64UrlEncode(bytes: Uint8Array): string {
  let value = 0
  let bits = 0
  let out = ''
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 6) {
      bits -= 6
      out += BASE64URL[(value >> bits) & 0x3f]
    }
  }
  if (bits > 0) out += BASE64URL[(value << (6 - bits)) & 0x3f]
  return out
}

function base64UrlDecode(value: string): Uint8Array {
  const text = value.replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(text.padEnd(Math.ceil(text.length / 4) * 4, '='))
  const out = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index++) out[index] = binary.charCodeAt(index)
  return out
}

function padTo(value: Uint8Array, block = 16): Uint8Array {
  const length = Math.ceil(value.length / block) * block
  const out = new Uint8Array(length)
  out.set(value)
  return out
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0))
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

function aesEcbEncrypt(key: Uint8Array, data: Uint8Array): Uint8Array {
  const padded = padTo(data)
  const out = new Uint8Array(padded.length)
  for (let offset = 0; offset < padded.length; offset += 16) {
    out.set(ecb(key, { disablePadding: true }).encrypt(padded.subarray(offset, offset + 16)), offset)
  }
  return out
}

function aesEcbDecrypt(key: Uint8Array, data: Uint8Array): Uint8Array {
  const padded = padTo(data)
  const out = new Uint8Array(padded.length)
  for (let offset = 0; offset < padded.length; offset += 16) {
    out.set(ecb(key, { disablePadding: true }).decrypt(padded.subarray(offset, offset + 16)), offset)
  }
  return out
}

function aesCbcEncrypt(key: Uint8Array, data: Uint8Array): Uint8Array {
  const padded = padTo(data)
  const out = new Uint8Array(padded.length)
  let previous = new Uint8Array(16)
  for (let offset = 0; offset < padded.length; offset += 16) {
    const block = new Uint8Array(16)
    for (let index = 0; index < 16; index++) block[index] = padded[offset + index]! ^ previous[index]!
    previous = ecb(key, { disablePadding: true }).encrypt(block)
    out.set(previous, offset)
  }
  return out
}

function aesCbcDecrypt(key: Uint8Array, data: Uint8Array): Uint8Array {
  const padded = padTo(data)
  const out = new Uint8Array(padded.length)
  let previous = new Uint8Array(16)
  for (let offset = 0; offset < padded.length; offset += 16) {
    const cipher = padded.subarray(offset, offset + 16)
    const plain = ecb(key, { disablePadding: true }).decrypt(cipher)
    for (let index = 0; index < 16; index++) out[offset + index] = plain[index]! ^ previous[index]!
    previous = new Uint8Array(cipher)
  }
  return out
}

function counterBlock(nonce: Uint8Array, blocks: number): Uint8Array {
  const out = new Uint8Array(16)
  out.set(nonce.subarray(0, 8))
  let value = blocks
  for (let index = 15; index >= 8; index--) {
    out[index] = value & 0xff
    value = Math.floor(value / 256)
  }
  return out
}

function attrKey(stored: Uint8Array): Uint8Array {
  const out = new Uint8Array(16)
  for (let index = 0; index < 16; index++) out[index] = stored[index]! ^ stored[index + 16]!
  return out
}

function packAttributes(attributes: Record<string, unknown>): Uint8Array {
  return padTo(new TextEncoder().encode(`MEGA${JSON.stringify(attributes)}`))
}

function encryptedAttributes(stored: Uint8Array, attributes: Record<string, unknown>): string {
  return base64UrlEncode(aesCbcEncrypt(attrKey(stored), packAttributes(attributes)))
}

function encryptedFolderAttributes(key: Uint8Array, attributes: Record<string, unknown>): string {
  return base64UrlEncode(aesCbcEncrypt(key, packAttributes(attributes)))
}

function mpi(value: bigint): Uint8Array {
  const bytes = toBytes(value)
  let bits = bytes.length * 8
  let first = bytes[0]!
  while ((first & 0x80) === 0 && bits > 0) {
    bits--
    first <<= 1
  }
  const header = new Uint8Array([(bits >> 8) & 0xff, bits & 0xff])
  return concat(header, bytes)
}

function nodeKey(storeKey: Uint8Array, parentKey: Uint8Array): string {
  return `${USER_HANDLE}:${base64UrlEncode(aesEcbEncrypt(parentKey, storeKey))}`
}

const DERIVED = pbkdf2(sha512, new TextEncoder().encode(PASSWORD), SALT, { c: 100000, dkLen: 32 })
const AES_KEY = DERIVED.subarray(0, 16)
const USER_HASH = base64UrlEncode(DERIVED.subarray(16, 32))

function derivedLogin(): { aesKey: Uint8Array; userHash: string } {
  return { aesKey: AES_KEY, userHash: USER_HASH }
}

function loginResponse(): Record<string, string> {
  const { aesKey } = derivedLogin()
  const privateKey = aesEcbEncrypt(aesKey, padTo(concat(
    mpi(P),
    mpi(Q),
    mpi(D),
    mpi(modInverse(P, Q)),
  )))
  const innerSid = new TextEncoder().encode('S'.repeat(43))
  const csid = base64UrlEncode(toBytes(modPow(fromBytes(innerSid), E, N)))
  return {
    k: base64UrlEncode(aesEcbEncrypt(aesKey, MASTER_KEY)),
    privk: base64UrlEncode(privateKey),
    csid,
  }
}

function snapshot(): unknown[] {
  const root: Record<string, unknown> = {
    h: 'ROOT', t: 2, ts: 1700000000,
    k: nodeKey(ROOT_KEY, MASTER_KEY),
    a: encryptedFolderAttributes(ROOT_KEY, { n: 'Cloud Drive' }),
  }
  const docs: Record<string, unknown> = {
    h: 'DOCS', p: 'ROOT', t: 1, ts: 1700000100,
    k: nodeKey(DOCS_KEY, ROOT_KEY),
    a: encryptedFolderAttributes(DOCS_KEY, { n: 'docs' }),
  }
  const fileA: Record<string, unknown> = {
    h: 'FILEA', p: 'ROOT', t: 0, ts: 1700000200, s: 10,
    k: nodeKey(FILE_A_STORED, ROOT_KEY),
    a: encryptedAttributes(FILE_A_STORED, { n: 'a.txt' }),
  }
  const fileB: Record<string, unknown> = {
    h: 'FILEB', p: 'ROOT', t: 0, ts: 1700000300, s: 20,
    k: nodeKey(FILE_B_STORED, ROOT_KEY),
    a: encryptedAttributes(FILE_B_STORED, { n: 'b.pdf' }),
  }
  const fileC: Record<string, unknown> = {
    h: 'FILEC', p: 'DOCS', t: 0, ts: 1700000400, s: 5,
    k: nodeKey(FILE_C_STORED, DOCS_KEY),
    a: encryptedAttributes(FILE_C_STORED, { n: 'c.txt' }),
  }
  const trash: Record<string, unknown> = {
    h: 'TRASH', p: 'ROOT', t: 4, ts: 1700000500,
    k: nodeKey(ROOT_KEY, ROOT_KEY),
    a: encryptedFolderAttributes(ROOT_KEY, { n: 'Rubbish Bin' }),
  }
  return [root, docs, fileA, fileB, fileC, trash]
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

type ApiRequest = Record<string, unknown>

interface FetchStub {
  fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
  apiCalls: ApiRequest[]
  bodies: string[]
}

function stubApi(handlers: {
  us0?: () => Response | Promise<Response>
  us?: (request: ApiRequest) => Response | Promise<Response>
  ug?: () => Response | Promise<Response>
  nodes?: () => Response | Promise<Response>
  api?: (request: ApiRequest) => Response | Promise<Response> | undefined
} = {}): FetchStub {
  const apiCalls: ApiRequest[] = []
  const bodies: string[] = []
  const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input)
    if (!url.includes('/cs?')) throw new Error(`unexpected request ${url}`)
    const raw = typeof init?.body === 'string' ? init.body : ''
    bodies.push(raw)
    const request = (JSON.parse(raw) as ApiRequest[])[0]!
    apiCalls.push(request)
    switch (request.a) {
      case 'us0': return handlers.us0 ? await handlers.us0() : json({ v: 2, s: base64UrlEncode(SALT) })
      case 'us': return handlers.us ? await handlers.us(request) : json([loginResponse()])
      case 'ug': return handlers.ug ? await handlers.ug() : json([{ u: USER_HANDLE, name: 'owner' }])
      case 'f': return handlers.nodes ? await handlers.nodes() : json([{ f: snapshot() }])
      default: {
        const response = handlers.api?.(request)
        if (response) return await response
        throw new Error(`unexpected API action ${String(request.a)}`)
      }
    }
  }
  return { fetch, apiCalls, bodies }
}

function context(overrides: Partial<DriverContext> = {}): DriverContext {
  const credentials: Record<string, string> = {
    password: PASSWORD,
    ...(overrides.credentials ?? {}),
  }
  return {
    userId: 'user-a',
    storageId: 'storage-a',
    type: 'mega',
    config: { email: EMAIL, ...(overrides.config ?? {}) },
    credentials,
    saveCredentials: vi.fn(async (patch) => { Object.assign(credentials, patch); return { ...credentials } }),
    markNeedsReauth: vi.fn(async () => undefined),
    ...overrides,
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('MEGA driver', () => {
  it('derives the v2 user hash, decrypts the key chain and paginates decrypted names', async () => {
    const stub = stubApi()
    vi.stubGlobal('fetch', stub.fetch)
    const driver = createMegaDriver(context())

    const { userHash } = derivedLogin()
    const first = await driver.list('/', { page: 1, pageSize: 2 })
    expect(first.entries.map((entry) => entry.name)).toEqual(['a.txt', 'b.pdf'])
    expect(first.cursor).toBe('2')
    expect(first.truncated).toBe(true)

    const second = await driver.list('/', { page: 2, pageSize: 2 })
    expect(second.entries.map((entry) => entry.name)).toEqual(['docs', 'Rubbish Bin'])
    expect(second.cursor).toBeNull()

    const us = stub.apiCalls.find((call) => call.a === 'us')!
    expect(us.user).toBe(EMAIL)
    expect(us.uh).toBe(userHash)
    expect(stub.bodies[1]).toContain('"a":"us"')
  })

  it('decrypts a file name inside a subfolder through the node key chain', async () => {
    const stub = stubApi()
    vi.stubGlobal('fetch', stub.fetch)
    const driver = createMegaDriver(context())

    const result = await driver.list('/docs')
    expect(result.entries.map((entry) => entry.name)).toEqual(['c.txt'])
    expect(result.entries[0]!.size).toBe(5)
    const stat = await driver.stat('/docs/c.txt')
    expect(stat).toMatchObject({ name: 'c.txt', kind: 'file', size: 5, ref: 'FILEC' })
  })

  it('marks the storage for re-authorization when the login is rejected', async () => {
    const mark = vi.fn(async () => undefined)
    const stub = stubApi({ us: () => json([-15]) })
    vi.stubGlobal('fetch', stub.fetch)
    const driver = createMegaDriver(context({ markNeedsReauth: mark }))

    await expect(driver.list('/')).rejects.toMatchObject({ kind: 'auth' })
    expect(mark).toHaveBeenCalled()
  })

  it('maps an upstream 429 to rate_limit without asking for re-authorization', async () => {
    const mark = vi.fn(async () => undefined)
    vi.stubGlobal('fetch', async () => new Response('{"error":"slow down"}', { status: 429, headers: { 'content-type': 'application/json', 'retry-after': '1' } }))
    const driver = createMegaDriver(context({ markNeedsReauth: mark }))

    await expect(driver.list('/')).rejects.toMatchObject({ kind: 'rate_limit' })
    expect(mark).not.toHaveBeenCalled()
  })

  it('maps a 404 download response to not_found', async () => {
    const stub = stubApi({
      api: (request) => request.a === 'g' ? new Response('missing', { status: 404 }) : undefined,
    })
    vi.stubGlobal('fetch', stub.fetch)
    const driver = createMegaDriver(context())

    await expect(driver.read('/a.txt')).rejects.toMatchObject({ kind: 'not_found' })
  })

  it('rejects an escaping path before any HTTP call', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const driver = createMegaDriver(context())

    await expect(driver.list('/docs/../secret')).rejects.toBeInstanceOf(DriverError)
    await expect(driver.mkdir('/docs/../escape')).rejects.toMatchObject({ kind: 'invalid' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('uploads with a real CTR stream and wraps the node key/attributes', async () => {
    const plaintext = new TextEncoder().encode('mega upload body')
    let uploadBody: Uint8Array | null = null
    let published: Array<Record<string, unknown>> | null = null
    const stub = stubApi({
      api: (request) => {
        if (request.a === 'u') return json([{ p: 'https://upload.example' }])
        if (request.a === 'p' && Array.isArray(request.n)) {
          published = request.n as Array<Record<string, unknown>>
          return json([{ f: [] }])
        }
        return undefined
      },
    })
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === 'https://upload.example/0') {
        uploadBody = new Uint8Array(init?.body as Uint8Array)
        return new Response('UPLOADHANDLE')
      }
      return await stub.fetch(input, init)
    })
    const driver = createMegaDriver(context())

    await driver.upload('/new.bin', plaintext, { size: plaintext.length })
    expect(published).not.toBeNull()
    const node = published![0]!
    expect(node.h).toBe('UPLOADHANDLE')
    expect(node.t).toBe(0)

    const stored = aesEcbDecrypt(ROOT_KEY, base64UrlDecode(String(node.k)))
    const key = attrKey(stored)
    const attributes = aesCbcDecrypt(key, base64UrlDecode(String(node.a)))
    expect(new TextDecoder().decode(attributes)).toContain('"n":"new.bin"')

    const nonce = stored.subarray(16, 24)
    const decrypted = ctr(key, counterBlock(nonce, 0)).decrypt(uploadBody!)
    expect(new TextDecoder().decode(decrypted)).toBe('mega upload body')
  })

  it('decrypts the downloaded AES-CTR body and returns the real plaintext', async () => {
    const plaintext = new TextEncoder().encode('hello mega')
    const fileKey = attrKey(FILE_A_STORED)
    const nonce = FILE_A_STORED.subarray(16, 24)
    const ciphertext = ctr(fileKey, counterBlock(nonce, 0)).encrypt(plaintext)
    let downloadUrl = ''
    const stub = stubApi({
      api: (request) => {
        if (request.a === 'g' && request.n === 'FILEA') return json([{ g: 'https://download.example/file', s: plaintext.length }])
        return undefined
      },
    })
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.startsWith('https://download.example/file')) {
        downloadUrl = url
        return new Response(ciphertext, { status: 200 })
      }
      return await stub.fetch(input, init)
    })
    const driver = createMegaDriver(context())

    const response = await driver.read('/a.txt')
    expect(downloadUrl).toBe(`https://download.example/file/0-${plaintext.length - 1}`)
    expect(await response.text()).toBe('hello mega')
    expect(response.headers.get('content-type')).toContain('text/plain')
  })

  it('returns a public link that carries the decrypted file key', async () => {
    const stub = stubApi({ api: (request) => request.a === 'l' ? json([{ ph: 'PUBLICHANDLE' }]) : undefined })
    vi.stubGlobal('fetch', stub.fetch)
    const driver = createMegaDriver(context())

    const link = await driver.directLink!('/a.txt')
    expect(link).toBe(`https://mega.nz/file/PUBLICHANDLE#${base64UrlEncode(FILE_A_STORED)}`)
    expect(driver.capabilities).toMatchObject({ read: true, write: true, mkdir: true, rename: true, move: true, delete: true, directLink: true, copy: false, range: false })
  })

  it('renames a node by re-encrypting its attributes with its own key', async () => {
    let renamed: ApiRequest | null = null
    const stub = stubApi({
      api: (request) => {
        if (request.a === 'a') {
          renamed = request
          return json([{ }])
        }
        return undefined
      },
    })
    vi.stubGlobal('fetch', stub.fetch)
    const driver = createMegaDriver(context())

    await driver.rename('/a.txt', 'renamed.txt')
    expect(renamed).not.toBeNull()
    const plain = aesCbcDecrypt(attrKey(FILE_A_STORED), base64UrlDecode(String(renamed!.at)))
    expect(new TextDecoder().decode(plain)).toContain('"n":"renamed.txt"')
  })
})
