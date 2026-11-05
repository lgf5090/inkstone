/**
 * Crypt driver — an rclone-crypt-v1 compatible envelope over another mounted storage.
 *
 * Ported from `OpenList-Worker/src/backend/drivers/crypt`. The reference only implements
 * `filename_encryption=off`, so this driver refuses `standard` / `obfuscate` by name instead of
 * pretending to support them. Names keep their suffix (`.bin` by default); contents are encrypted
 * with AES-256-CTR under a key derived by scrypt.
 *
 * File format (v1): `[nonce: 16 bytes][reserved: 16 bytes][ciphertext]`, so the encrypted size is
 * always the plaintext size plus 32. The scrypt parameters are the rclone ones:
 * `N=16384, r=8, p=1, dkLen=64`; the first 32 bytes are the data key and the rest is the (unused)
 * file-name key.
 *
 * The 16-byte nonce is the AES-CTR initial counter, so a byte range can be answered by decrypting
 * only the 16-byte-aligned ciphertext blocks that cover it, advancing the 128-bit counter by the
 * block count before the first requested block.
 */
import { scryptAsync } from '@noble/hashes/scrypt.js'
import { findCloudDriveDriver } from '@shared/clouddrive/drivers'
import {
  DriverError,
  asBytes,
  driverEntryMime,
  type DriverContext,
  type DriverEntry,
  type DriverListOptions,
  type DriverListResult,
  type DriverUploadOptions,
  type MountDriver,
  type ResolvedMount,
} from './contract'
import {
  driverPath,
} from './http'

const HEADER_SIZE = 32
const NONCE_SIZE = 16
const BLOCK_SIZE = 16
const STREAM_BLOCK = 1024 * 1024
const KEY_CHECK_MESSAGE = 'inkstone-crypt-v1'
const MAX_SECRET_LENGTH = 1024

/** A byte range in the decrypted stream. */
interface PlainRange {
  start: number
  end: number
}

function isControlCharacter(value: string): boolean {
  return /[\u0000-\u001f\u007f]/.test(value)
}

function validateSecret(value: string, label: string, required: boolean): string {
  if (!value) {
    if (required) throw DriverError.invalid(`Crypt needs a ${label}.`)
    return ''
  }
  if (value.length > MAX_SECRET_LENGTH) {
    throw DriverError.invalid(`The crypt ${label} is longer than ${MAX_SECRET_LENGTH} characters.`)
  }
  if (isControlCharacter(value)) {
    throw DriverError.invalid(`The crypt ${label} contains a control character.`)
  }
  return value
}

function filenameMode(raw: string): 'off' {
  const mode = (raw.trim() || 'off').toLowerCase()
  if (mode === 'off') return 'off'
  if (mode === 'standard' || mode === 'obfuscate') {
    throw DriverError.unsupported(
      `Crypt filename encryption "${mode}" is not implemented; only "off" is supported.`,
    )
  }
  throw DriverError.invalid(`Crypt filename encryption "${raw}" is not a known mode.`)
}

function base64Of(bytes: Uint8Array): string {
  let binary = ''
  for (let index = 0; index < bytes.length; index++) binary += String.fromCharCode(bytes[index]!)
  return btoa(binary)
}

async function keyCheckOf(dataKey: Uint8Array): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    dataKey as BufferSource,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(KEY_CHECK_MESSAGE))
  return base64Of(new Uint8Array(signature))
}

/** Advances a 128-bit big-endian counter by `blocks` AES blocks. */
function advanceCounter(counter: Uint8Array, blocks: number): void {
  if (blocks <= 0) return
  let value = 0n
  for (const byte of counter) value = (value << 8n) | BigInt(byte)
  value = (value + BigInt(blocks)) & ((1n << 128n) - 1n)
  for (let index = counter.length - 1; index >= 0; index--) {
    counter[index] = Number(value & 0xffn)
    value >>= 8n
  }
}

function concatBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
  if (left.length === 0) return right
  if (right.length === 0) return left
  const merged = new Uint8Array(left.length + right.length)
  merged.set(left, 0)
  merged.set(right, left.length)
  return merged
}

/** `null` means "ignore the header", `'unsatisfiable'` means "answer 416". */
function parsePlainRange(value: string | null | undefined, size: number): PlainRange | 'unsatisfiable' | null {
  if (!value) return null
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim())
  if (!match) return null
  const first = match[1] ?? ''
  const second = match[2] ?? ''
  if (!first && !second) return null
  if (!first) {
    const suffix = Number(second)
    if (!Number.isFinite(suffix) || suffix <= 0 || size === 0) return 'unsatisfiable'
    return { start: Math.max(0, size - suffix), end: size - 1 }
  }
  const start = Number(first)
  if (!Number.isFinite(start) || start >= size) return 'unsatisfiable'
  const end = second ? Math.min(Number(second), size - 1) : size - 1
  if (!Number.isFinite(end) || end < start) return 'unsatisfiable'
  return { start, end }
}

interface DecryptOptions {
  key: CryptoKey
  counter: Uint8Array
  /** Raw bytes at the front of the source that must not reach AES (the 32-byte header). */
  discardEncrypted?: number
  /** Decrypted bytes to drop before emitting (the partial block before a Range start). */
  discardPlain?: number
  /** Emit at most this many plaintext bytes. */
  maxBytes?: number
}

/**
 * Streams a ciphertext body through block-wise AES-CTR.
 *
 * Chunks are accumulated up to 1 MiB and only complete 16-byte blocks are decrypted before the
 * stream ends, so the counter stays aligned across chunk boundaries. The final partial block is
 * decrypted once the source is done.
 */
function decryptBody(
  source: ReadableStream<Uint8Array>,
  options: DecryptOptions,
): ReadableStream<Uint8Array> {
  const reader = source.getReader()
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      let pending: Uint8Array = new Uint8Array(0)
      let discardEncrypted = options.discardEncrypted ?? 0
      let discardPlain = options.discardPlain ?? 0
      let emitted = 0
      const maxBytes = options.maxBytes ?? Number.POSITIVE_INFINITY

      const emit = (plain: Uint8Array): boolean => {
        let view = plain
        if (discardPlain > 0) {
          const drop = Math.min(discardPlain, view.length)
          discardPlain -= drop
          view = view.subarray(drop)
        }
        if (view.length === 0) return emitted >= maxBytes
        if (emitted + view.length > maxBytes) view = view.subarray(0, maxBytes - emitted)
        if (view.length > 0) {
          controller.enqueue(view)
          emitted += view.length
        }
        return emitted >= maxBytes
      }

      const decryptPiece = async (piece: Uint8Array): Promise<Uint8Array> => {
        if (piece.length === 0) return piece
        const plaintext = await crypto.subtle.decrypt(
          { name: 'AES-CTR', counter: options.counter as BufferSource, length: 128 },
          options.key,
          piece as BufferSource,
        )
        advanceCounter(options.counter, Math.ceil(piece.length / BLOCK_SIZE))
        return new Uint8Array(plaintext)
      }

      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) {
            if (pending.length > 0) await emit(await decryptPiece(pending))
            break
          }
          let chunk: Uint8Array = value ?? new Uint8Array(0)
          if (discardEncrypted > 0) {
            const drop = Math.min(discardEncrypted, chunk.length)
            discardEncrypted -= drop
            chunk = chunk.subarray(drop)
          }
          if (chunk.length === 0) continue
          pending = concatBytes(pending, chunk)
          if (pending.length >= STREAM_BLOCK) {
            const usable = Math.floor(pending.length / BLOCK_SIZE) * BLOCK_SIZE
            if (usable > 0) {
              const plain = await decryptPiece(pending.subarray(0, usable))
              pending = pending.subarray(usable)
              if (emit(plain)) {
                await reader.cancel().catch(() => undefined)
                break
              }
            }
          }
          if (emitted >= maxBytes) {
            await reader.cancel().catch(() => undefined)
            break
          }
        }
        controller.close()
      } catch (error) {
        controller.error(
          error instanceof DriverError
            ? error
            : DriverError.upstream(
                `Crypt could not decrypt the file${error instanceof Error ? `: ${error.message}` : ''}`,
              ),
        )
      }
    },
    cancel(reason) {
      return reader.cancel(reason)
    },
  })
}

class CryptDriver implements MountDriver {
  readonly definition = findCloudDriveDriver('crypt')!
  readonly capabilities = this.definition.capabilities
  private readonly suffix: string
  private readonly root: string
  private readonly showHidden: boolean
  private readonly remoteReference: string
  private mountPromise: Promise<ResolvedMount> | null = null
  private keyPromise: Promise<CryptoKey> | null = null

  constructor(private readonly ctx: DriverContext) {
    this.remoteReference = this.configText('remotePath').trim()
    if (!this.remoteReference) throw DriverError.invalid('Crypt needs the mount reference in remotePath.')
    this.suffix = this.configText('encryptedSuffix', '.bin')
    if (this.suffix.includes('/') || isControlCharacter(this.suffix)) {
      throw DriverError.invalid('The crypt encryptedSuffix must be a file-name suffix.')
    }
    this.root = driverPath(this.configText('rootPath', '/') || '/')
    this.showHidden = this.configBoolean('showHidden')
    filenameMode(this.configText('filenameEncryption', 'off'))
  }

  private configText(key: string, fallback = ''): string {
    const value = this.ctx.config[key]
    return typeof value === 'string' ? value : fallback
  }

  private configBoolean(key: string): boolean {
    const value = this.ctx.config[key]
    if (typeof value === 'boolean') return value
    if (typeof value === 'string') return value.trim().toLowerCase() === 'true'
    return false
  }

  private async mount(): Promise<ResolvedMount> {
    if (!this.ctx.resolveMount) {
      throw DriverError.unsupported('Crypt needs the host that resolves cross-mount paths.')
    }
    this.mountPromise ??= this.ctx.resolveMount(this.remoteReference)
    return await this.mountPromise
  }

  private async key(): Promise<CryptoKey> {
    this.keyPromise ??= this.deriveKey()
    return await this.keyPromise
  }

  /**
   * Derives the rclone keys and proves the password with a key check stored in the vault.
   *
   * The check is what turns AES-CTR's silent garbage into an "auth" error: CTR has no MAC, so a
   * wrong key decrypts to plausible-looking bytes. The first successful derivation writes the
   * check back so later attempts (and other mounts on the same storage) can verify it.
   */
  private async deriveKey(): Promise<CryptoKey> {
    const password = validateSecret(this.ctx.credentials.password ?? '', 'password', true)
    const salt = validateSecret(this.ctx.credentials.salt ?? '', 'salt', false)
    const derived = await scryptAsync(password, salt, { N: 16_384, r: 8, p: 1, dkLen: 64 })
    const dataKey = derived.subarray(0, 32)
    const check = await keyCheckOf(dataKey)
    const stored = this.ctx.credentials.keyCheck ?? ''
    if (stored && stored !== check) throw DriverError.auth('wrong password')
    if (!stored) await this.ctx.saveCredentials({ keyCheck: check })
    return await crypto.subtle.importKey(
      'raw',
      dataKey as BufferSource,
      { name: 'AES-CTR' },
      false,
      ['decrypt', 'encrypt'],
    )
  }

  private async ready(): Promise<{ mount: ResolvedMount; key: CryptoKey }> {
    return { mount: await this.mount(), key: await this.key() }
  }

  private joinRemote(clean: string): string {
    const base = this.root === '/' ? '' : this.root
    return driverPath(`${base}${clean}`)
  }

  private encryptedPath(clean: string): string {
    return `${this.joinRemote(clean)}${this.suffix}`
  }

  private encryptedName(name: string): string {
    return `${name}${this.suffix}`
  }

  private decryptedName(name: string): string {
    if (!this.suffix) return name
    return name.endsWith(this.suffix) ? name.slice(0, -this.suffix.length) : name
  }

  private decryptedSize(size: number): number {
    return Math.max(0, size - HEADER_SIZE)
  }

  /** Reads exactly the first 32 bytes of the ciphertext and cancels the rest of the body. */
  private async readHeader(driver: MountDriver, remotePath: string): Promise<Uint8Array> {
    const response = await driver.read(remotePath, `bytes=0-${HEADER_SIZE - 1}`)
    if (!response.ok && response.status !== 206) {
      throw DriverError.upstream(`Crypt could not read the encrypted header (HTTP ${response.status}).`)
    }
    const body = response.body
    if (!body) throw DriverError.upstream('The encrypted file has no header.')
    const reader = body.getReader()
    const collected: Uint8Array[] = []
    let length = 0
    try {
      while (length < HEADER_SIZE) {
        const { done, value } = await reader.read()
        if (done) break
        if (value) {
          collected.push(value)
          length += value.length
        }
      }
    } finally {
      await reader.cancel().catch(() => undefined)
    }
    const header = new Uint8Array(length)
    let offset = 0
    for (const part of collected) {
      header.set(part, offset)
      offset += part.length
    }
    if (header.length < HEADER_SIZE) {
      throw DriverError.upstream('The encrypted file is shorter than its 32-byte header.')
    }
    return header.subarray(0, NONCE_SIZE)
  }

  private contentHeaders(name: string, size: number): Headers {
    return new Headers({
      'content-type': driverEntryMime(name),
      'content-length': String(size),
      'accept-ranges': 'bytes',
    })
  }

  async list(path: string, options: DriverListOptions = {}): Promise<DriverListResult> {
    const clean = driverPath(path)
    const { mount } = await this.ready()
    const result = await mount.driver.list(this.joinRemote(clean), options)
    const entries: DriverEntry[] = []
    for (const entry of result.entries) {
      const name = entry.kind === 'folder' ? entry.name : this.decryptedName(entry.name)
      if (!this.showHidden && name.startsWith('.')) continue
      entries.push(entry.kind === 'folder'
        ? { ...entry, name }
        : { ...entry, name, size: this.decryptedSize(entry.size), mime: driverEntryMime(name) })
    }
    return { entries, cursor: result.cursor, truncated: result.truncated }
  }

  async stat(path: string): Promise<DriverEntry> {
    const clean = driverPath(path)
    const { mount } = await this.ready()
    if (clean === '/') {
      return { name: 'root', kind: 'folder', size: 0, modifiedAt: Date.now() }
    }
    // Files live under the encrypted suffix; folders keep their virtual name. Try the file first,
    // because a virtual file name never carries the suffix, then fall back to the folder path.
    let encryptedEntry: DriverEntry | null = null
    try {
      const candidate = await mount.driver.stat(this.encryptedPath(clean))
      if (candidate.kind !== 'folder') encryptedEntry = candidate
    } catch {
      encryptedEntry = null
    }
    if (encryptedEntry) {
      const name = this.decryptedName(encryptedEntry.name)
      return {
        ...encryptedEntry,
        name,
        size: this.decryptedSize(encryptedEntry.size),
        mime: driverEntryMime(name),
      }
    }
    const entry = await mount.driver.stat(this.joinRemote(clean))
    if (entry.kind === 'folder') return { ...entry, size: 0 }
    const name = this.decryptedName(entry.name)
    return {
      ...entry,
      name,
      size: this.decryptedSize(entry.size),
      mime: driverEntryMime(name),
    }
  }

  async read(path: string, range?: string | null): Promise<Response> {
    const clean = driverPath(path)
    if (clean === '/') throw DriverError.unsupported('A folder cannot be read as a file.')
    const { mount, key } = await this.ready()
    const remotePath = this.encryptedPath(clean)
    const entry = await mount.driver.stat(remotePath)
    if (entry.kind !== 'file') throw DriverError.unsupported('A folder cannot be read as a file.')
    if (entry.size < HEADER_SIZE) {
      throw DriverError.upstream('The encrypted file is shorter than its 32-byte header.')
    }
    const name = this.decryptedName(entry.name)
    const plainSize = this.decryptedSize(entry.size)
    const nonce = await this.readHeader(mount.driver, remotePath)

    if (!range) {
      const response = await mount.driver.read(remotePath, null)
      if (!response.ok) {
        throw DriverError.upstream(`Crypt could not read the encrypted file (HTTP ${response.status}).`)
      }
      const body = response.body ?? new ReadableStream<Uint8Array>({
        start(controller) {
          controller.close()
        },
      })
      const stream = decryptBody(body, {
        key,
        counter: new Uint8Array(nonce),
        discardEncrypted: HEADER_SIZE,
        maxBytes: plainSize,
      })
      return new Response(stream, { status: 200, headers: this.contentHeaders(name, plainSize) })
    }

    const parsed = parsePlainRange(range, plainSize)
    if (parsed === 'unsatisfiable') {
      return new Response(null, {
        status: 416,
        headers: { 'content-range': `bytes */${plainSize}` },
      })
    }
    if (!parsed) {
      // A malformed or multi-range header is ignored, as HTTP allows.
      const response = await mount.driver.read(remotePath, null)
      if (!response.ok) {
        throw DriverError.upstream(`Crypt could not read the encrypted file (HTTP ${response.status}).`)
      }
      const body = response.body ?? new ReadableStream<Uint8Array>({
        start(controller) {
          controller.close()
        },
      })
      const stream = decryptBody(body, {
        key,
        counter: new Uint8Array(nonce),
        discardEncrypted: HEADER_SIZE,
        maxBytes: plainSize,
      })
      return new Response(stream, { status: 200, headers: this.contentHeaders(name, plainSize) })
    }

    // Decrypt whole 16-byte blocks: the counter can only be advanced block by block.
    const blockStart = Math.floor(parsed.start / BLOCK_SIZE) * BLOCK_SIZE
    const blockEnd = Math.min(plainSize, Math.ceil((parsed.end + 1) / BLOCK_SIZE) * BLOCK_SIZE)
    const cipherStart = HEADER_SIZE + blockStart
    const cipherEnd = HEADER_SIZE + blockEnd - 1
    const response = await mount.driver.read(remotePath, `bytes=${cipherStart}-${cipherEnd}`)
    if (!response.ok && response.status !== 206) {
      throw DriverError.upstream(`Crypt could not read the encrypted range (HTTP ${response.status}).`)
    }
    const body = response.body ?? new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close()
      },
    })
    // A honouring upstream starts at cipherStart; one that ignores Range starts at byte zero and
    // still contains the header.
    const startsAtZero = response.status !== 206
    const counter = new Uint8Array(nonce)
    advanceCounter(counter, blockStart / BLOCK_SIZE)
    const stream = decryptBody(body, {
      key,
      counter,
      discardEncrypted: startsAtZero ? cipherStart : 0,
      discardPlain: parsed.start - blockStart,
      maxBytes: parsed.end - parsed.start + 1,
    })
    const headers = this.contentHeaders(name, parsed.end - parsed.start + 1)
    headers.set('content-range', `bytes ${parsed.start}-${parsed.end}/${plainSize}`)
    return new Response(stream, { status: 206, headers })
  }

  async upload(path: string, body: Uint8Array | ReadableStream, options: DriverUploadOptions): Promise<void> {
    const clean = driverPath(path)
    if (clean === '/') throw DriverError.invalid('The root is not a file.')
    const { mount, key } = await this.ready()
    const bytes = await asBytes(body)
    if (bytes.byteLength !== options.size) {
      throw DriverError.invalid('The upload body does not match the declared size.')
    }
    const nonce = crypto.getRandomValues(new Uint8Array(NONCE_SIZE))
    const header = new Uint8Array(HEADER_SIZE)
    header.set(nonce, 0)
    crypto.getRandomValues(header.subarray(NONCE_SIZE))
    const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
      { name: 'AES-CTR', counter: nonce as BufferSource, length: 128 },
      key,
      bytes as BufferSource,
    ))
    const encrypted = new Uint8Array(HEADER_SIZE + ciphertext.length)
    encrypted.set(header, 0)
    encrypted.set(ciphertext, HEADER_SIZE)
    await mount.driver.upload(this.encryptedPath(clean), encrypted, {
      size: encrypted.length,
      contentType: 'application/octet-stream',
      onProgress: (uploaded, total) => {
        if (!options.onProgress || total <= 0) return
        options.onProgress(Math.min(bytes.length, Math.round((uploaded / total) * bytes.length)), bytes.length)
      },
    })
    options.onProgress?.(bytes.length, bytes.length)
  }

  async mkdir(path: string): Promise<void> {
    const clean = driverPath(path)
    if (clean === '/') return
    const { mount } = await this.ready()
    await mount.driver.mkdir(this.joinRemote(clean))
  }

  async rename(path: string, newName: string): Promise<void> {
    const clean = driverPath(path)
    if (!newName || newName.includes('/') || isControlCharacter(newName)) {
      throw DriverError.invalid('A file name must be a single path segment.')
    }
    const { mount } = await this.ready()
    const kind = (await this.stat(clean)).kind
    if (kind === 'folder') {
      await mount.driver.rename(this.joinRemote(clean), newName)
      return
    }
    await mount.driver.rename(this.encryptedPath(clean), this.encryptedName(newName))
  }

  async move(fromPath: string, toPath: string): Promise<void> {
    const from = driverPath(fromPath)
    const to = driverPath(toPath)
    const { mount } = await this.ready()
    const kind = (await this.stat(from)).kind
    const suffix = kind === 'file' ? this.suffix : ''
    await mount.driver.move(`${this.joinRemote(from)}${suffix}`, `${this.joinRemote(to)}${suffix}`)
  }

  async copy(fromPath: string, toPath: string): Promise<void> {
    const from = driverPath(fromPath)
    const to = driverPath(toPath)
    const { mount } = await this.ready()
    if (!mount.driver.copy) throw DriverError.unsupported('The underlying storage cannot copy files.')
    const kind = (await this.stat(from)).kind
    const suffix = kind === 'file' ? this.suffix : ''
    await mount.driver.copy(`${this.joinRemote(from)}${suffix}`, `${this.joinRemote(to)}${suffix}`)
  }

  async remove(path: string): Promise<void> {
    const clean = driverPath(path)
    const { mount } = await this.ready()
    const kind = (await this.stat(clean)).kind
    await mount.driver.remove(kind === 'file' ? this.encryptedPath(clean) : this.joinRemote(clean))
  }

  async test(): Promise<{ ok: boolean; message: string }> {
    try {
      const { mount } = await this.ready()
      return { ok: true, message: `Crypt is ready over ${mount.mountName}${this.suffix ? ` · suffix ${this.suffix}` : ''}` }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : 'Crypt is unavailable' }
    }
  }
}

export function createCryptDriver(ctx: DriverContext): MountDriver {
  return new CryptDriver(ctx)
}
