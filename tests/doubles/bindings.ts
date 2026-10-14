import type { Env } from '../../src/worker/env'

/**
 * The bindings a route test hands to `app.fetch`, built from pieces that behave.
 *
 * `Env` has three bindings that are not optional — `DB`, `ASSETS` and `OAUTH_KV` — and a test that
 * writes `env as never` gives the route none of them while the checker looks away. The day a route
 * starts reading a binding the fixture never provided, that test still passes and production throws.
 * These doubles answer like the platform does, so a route that reaches for something the test did
 * not wire gets a miss, an empty store or a loud error rather than `undefined`.
 */

/** One stored value, held the way the platform holds it: bytes plus the metadata a put declared. */
interface StoredObject {
  bytes: Uint8Array
  contentType?: string
  customMetadata?: Record<string, string>
}

/** A value R2 or KV can be handed, before it is narrowed to the bytes the doubles store. */
type PutValue = ArrayBuffer | ArrayBufferView | Blob | ReadableStream | string

/** Any value the platform accepts for a write, as the bytes it holds. */
async function toBytes(value: PutValue): Promise<Uint8Array> {
  if (typeof value === 'string') return new TextEncoder().encode(value)
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  if (ArrayBuffer.isView(value)) {
    const bytes = new Uint8Array(value.byteLength)
    bytes.set(new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)))
    return bytes
  }
  if (value instanceof Blob) return new Uint8Array(await value.arrayBuffer())
  const chunks: Uint8Array[] = []
  const reader = value.getReader()
  for (;;) {
    const { done, value: chunk } = await reader.read()
    if (done) break
    chunks.push(chunk)
  }
  const bytes = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0))
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

/** FNV-1a over the stored bytes: stable per content, so an `etag` survives a round trip unchanged. */
function fingerprint(bytes: Uint8Array): string {
  let hash = 0x811c9dc5
  for (const byte of bytes) {
    hash ^= byte
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

class R2ObjectStub implements R2ObjectBody {
  readonly key: string
  readonly version = '1'
  readonly size: number
  readonly etag: string
  readonly httpEtag: string
  readonly checksums: R2Checksums
  readonly uploaded: Date
  readonly httpMetadata?: R2HTTPMetadata
  readonly customMetadata?: Record<string, string>
  readonly range?: R2Range
  readonly storageClass = 'Standard'
  readonly ssecKeyMd5?: string
  private used = false

  constructor(key: string, private readonly object: StoredObject, uploaded: Date) {
    this.key = key
    this.size = object.bytes.byteLength
    this.etag = fingerprint(object.bytes)
    this.httpEtag = `"${this.etag}"`
    this.checksums = { toJSON: () => ({}) }
    this.uploaded = uploaded
    this.httpMetadata = object.contentType ? { contentType: object.contentType } : undefined
    this.customMetadata = object.customMetadata
  }

  get body(): ReadableStream<Uint8Array> {
    const bytes = this.object.bytes
    this.used = true
    return new ReadableStream({
      start(controller) {
        controller.enqueue(bytes)
        controller.close()
      },
    })
  }

  get bodyUsed(): boolean {
    return this.used
  }

  async arrayBuffer(): Promise<ArrayBuffer> {
    this.used = true
    return new Uint8Array(this.object.bytes).buffer
  }

  async bytes(): Promise<Uint8Array> {
    this.used = true
    return this.object.bytes.slice()
  }

  async text(): Promise<string> {
    this.used = true
    return new TextDecoder().decode(this.object.bytes)
  }

  async json<T>(): Promise<T> {
    return JSON.parse(await this.text()) as T
  }

  async blob(): Promise<Blob> {
    this.used = true
    return new Blob([new Uint8Array(this.object.bytes)])
  }

  writeHttpMetadata(headers: Headers): void {
    if (this.object.contentType) headers.set('content-type', this.object.contentType)
  }
}

/**
 * An in-memory object store that keeps what a put declared and hands it back on get.
 *
 * `objects` and `types` are the assertions a test makes about what an archive step wrote, so they
 * stay visible instead of being reached through a cast of the binding.
 */
export interface TestR2Bucket extends R2Bucket {
  /** Every key that holds bytes right now, in insertion order. */
  readonly objects: Map<string, Uint8Array>
  /** The content type each put declared, which real R2 returns on `get`. */
  readonly types: Map<string, string>
  /** The custom metadata each put declared. */
  readonly metadata: Map<string, Record<string, string>>
}

class InMemoryR2Bucket implements TestR2Bucket {
  readonly objects = new Map<string, Uint8Array>()
  readonly types = new Map<string, string>()
  readonly metadata = new Map<string, Record<string, string>>()
  private readonly uploaded = new Map<string, Date>()

  async head(key: string): Promise<R2Object | null> {
    const bytes = this.objects.get(key)
    if (!bytes) return null
    return new R2ObjectStub(key, { bytes }, this.uploaded.get(key) ?? new Date(0))
  }

  async get(key: string, options?: R2GetOptions): Promise<R2ObjectBody | null> {
    if (options?.onlyIf || options?.range) {
      throw new TypeError('the test R2 double does not serve conditional or ranged reads')
    }
    const bytes = this.objects.get(key)
    if (!bytes) return null
    return new R2ObjectStub(key, this.stored(key, bytes), this.uploaded.get(key) ?? new Date(0))
  }

  async put(
    key: string,
    value: PutValue | null,
    options?: R2PutOptions,
  ): Promise<R2Object> {
    if (options?.onlyIf) {
      throw new TypeError('the test R2 double does not serve conditional writes')
    }
    if (value === null) {
      // Real R2 drops the object and answers with the one it removed; this double cannot name that
      // object, so it refuses instead of deleting quietly.
      throw new TypeError('the test R2 double does not serve put(key, null)')
    }
    const bytes = await toBytes(value)
    this.objects.set(key, bytes)
    this.uploaded.set(key, new Date())
    const contentType = options?.httpMetadata instanceof Headers
      ? options.httpMetadata.get('content-type') ?? undefined
      : options?.httpMetadata?.contentType
    if (contentType) this.types.set(key, contentType)
    else this.types.delete(key)
    if (options?.customMetadata) this.metadata.set(key, options.customMetadata)
    else this.metadata.delete(key)
    return new R2ObjectStub(key, this.stored(key, bytes), this.uploaded.get(key) ?? new Date(0))
  }

  async createMultipartUpload(key: string, options?: R2MultipartOptions): Promise<R2MultipartUpload> {
    const uploadId = `upload-${key}-${this.objects.size}`
    const parts = new Map<number, Uint8Array>()
    const bucket = this
    return {
      key,
      uploadId,
      async uploadPart(partNumber, value) {
        const bytes = await toBytes(value)
        parts.set(partNumber, bytes)
        return { partNumber, etag: fingerprint(bytes) }
      },
      async abort() {
        parts.clear()
      },
      async complete(uploadedParts) {
        const ordered: Uint8Array[] = []
        for (const part of uploadedParts.slice().sort((a, b) => a.partNumber - b.partNumber)) {
          const bytesOfPart = parts.get(part.partNumber)
          if (!bytesOfPart) {
            throw new TypeError(`part ${part.partNumber} of ${key} was completed but never uploaded`)
          }
          ordered.push(bytesOfPart)
        }
        const assembled = new Uint8Array(ordered.reduce((sum, part) => sum + part.byteLength, 0))
        let offset = 0
        for (const part of ordered) {
          assembled.set(part, offset)
          offset += part.byteLength
        }
        return bucket.put(key, assembled, options)
      },
    }
  }

  resumeMultipartUpload(key: string, uploadId: string): R2MultipartUpload {
    throw new TypeError(`the test R2 double cannot resume upload ${uploadId} of ${key}`)
  }

  async delete(keys: string | string[]): Promise<void> {
    for (const key of Array.isArray(keys) ? keys : [keys]) this.deleteOne(key)
  }

  async list(options?: R2ListOptions): Promise<R2Objects> {
    const all = [...this.objects.keys()].sort()
    const matched = options?.prefix ? all.filter((key) => key.startsWith(options.prefix!)) : all
    const from = options?.cursor ? matched.indexOf(options.cursor) + 1 : 0
    const visible = matched.slice(Math.max(from, 0))
    const limited = options?.limit === undefined ? visible : visible.slice(0, options.limit)
    const rest = visible.length - limited.length
    if (options?.delimiter) {
      throw new TypeError('the test R2 double does not group keys by delimiter')
    }
    if (rest > 0) {
      return {
        objects: limited.map((key) => this.storedObject(key)),
        delimitedPrefixes: [],
        truncated: true,
        cursor: limited[limited.length - 1] ?? '',
      }
    }
    return { objects: limited.map((key) => this.storedObject(key)), delimitedPrefixes: [], truncated: false }
  }

  private stored(key: string, bytes: Uint8Array): StoredObject {
    return {
      bytes,
      contentType: this.types.get(key),
      customMetadata: this.metadata.get(key),
    }
  }

  private storedObject(key: string): R2Object {
    return new R2ObjectStub(key, this.stored(key, this.objects.get(key)!), this.uploaded.get(key) ?? new Date(0))
  }

  private deleteOne(key: string): void {
    this.objects.delete(key)
    this.types.delete(key)
    this.metadata.delete(key)
    this.uploaded.delete(key)
  }
}

/** An R2 bucket held in memory, with the maps a test asserts on left in the open. */
export function testR2Bucket(): TestR2Bucket {
  return new InMemoryR2Bucket()
}

class TestKVNamespace implements KVNamespace<string> {
  private readonly values = new Map<string, { bytes: Uint8Array; metadata?: unknown }>()

  /**
   * `KVNamespace.get` is fourteen overloads answering with a string, an ArrayBuffer, a
   * ReadableStream or a Map, and no single return type names all four, so this promise is `any`: the
   * body reads the one store every overload reads, and the loosening never leaves this method. A
   * caller holds `KVNamespace`, so `await env.OAUTH_KV.get(key, 'json')` is still typed.
   */
  async get(key: string | string[], typeOrOptions?: unknown): Promise<any> {
    const type = typeof typeOrOptions === 'string' ? typeOrOptions : (typeOrOptions as { type?: string } | undefined)?.type
    if (Array.isArray(key)) {
      const found = new Map<string, unknown>()
      for (const one of key) found.set(one, this.read(one, type))
      return found
    }
    return this.read(key, type)
  }

  async list<Metadata = unknown>(options?: KVNamespaceListOptions): Promise<KVNamespaceListResult<Metadata, string>> {
    const all = [...this.values.keys()].sort()
    const matched = options?.prefix ? all.filter((key) => key.startsWith(options.prefix!)) : all
    const limit = options?.limit ?? 1000
    const keys = matched.slice(0, limit)
    // Whatever a test put in as the metadata is what the caller asked the binding to hand back.
    const listed = (key: string): KVNamespaceListKey<Metadata, string> => ({
      name: key,
      metadata: this.values.get(key)?.metadata as Metadata | undefined,
    })
    if (matched.length > keys.length) {
      return {
        keys: keys.map(listed),
        list_complete: false,
        cursor: keys[keys.length - 1] ?? '',
        cacheStatus: null,
      }
    }
    return { keys: keys.map(listed), list_complete: true, cacheStatus: null }
  }

  async put(
    key: string,
    value: string | ArrayBuffer | ArrayBufferView | ReadableStream,
    options?: KVNamespacePutOptions,
  ): Promise<void> {
    this.values.set(key, { bytes: await toBytes(value), metadata: options?.metadata })
  }

  async getWithMetadata(key: string | string[], typeOrOptions?: unknown): Promise<any> {
    const type = typeof typeOrOptions === 'string' ? typeOrOptions : (typeOrOptions as { type?: string } | undefined)?.type
    if (Array.isArray(key)) {
      const found = new Map<string, unknown>()
      for (const one of key) {
        found.set(one, { value: this.read(one, type), metadata: this.values.get(one)?.metadata ?? null, cacheStatus: null })
      }
      return found
    }
    return { value: this.read(key, type), metadata: this.values.get(key)?.metadata ?? null, cacheStatus: null }
  }

  async delete(key: string): Promise<void> {
    this.values.delete(key)
  }

  private read(key: string, type?: string): unknown {
    const stored = this.values.get(key)
    if (!stored) return null
    const bytes = stored.bytes
    if (type === 'json') return JSON.parse(new TextDecoder().decode(bytes))
    if (type === 'arrayBuffer') return new Uint8Array(bytes).buffer
    if (type === 'stream') {
      return new ReadableStream({
        start(controller) {
          controller.enqueue(bytes)
          controller.close()
        },
      })
    }
    return new TextDecoder().decode(bytes)
  }
}

/** A KV namespace held in a Map, so a test that exercises KV gets a store that answers. */
export function testKVNamespace(): KVNamespace<string> {
  return new TestKVNamespace()
}

/**
 * A `Fetcher`: the binding shape, a `fetch` that answers plus the socket method no test opens.
 *
 * `Env.ASSETS` is this shape rather than a bare function, so the object carries `connect` as well and
 * says out loud when a route asks it for a socket.
 */
function fetcherOf(fetch: (input: RequestInfo | URL, init?: RequestInit) => Response | Promise<Response>): Fetcher {
  return {
    async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
      return await fetch(input, init)
    },
    connect(): never {
      throw new TypeError('the test fetcher does not open sockets')
    },
  }
}

/**
 * The static-asset fetcher: every route that reaches for an asset is looking for a file the test
 * never uploaded, so the honest answer is a miss that says which one.
 */
export function testAssets(): Fetcher {
  return fetcherOf(async (input, init) => {
    const request = new Request(input instanceof Request ? input : String(input), init)
    return new Response(`No asset configured for ${request.url}`, {
      status: 404,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    })
  })
}

function emptyMeta() {
  return {
    duration: 0,
    size_after: 0,
    rows_read: 0,
    rows_written: 0,
    last_row_id: 0,
    changed_db: false,
    changes: 0,
  }
}

function emptyResult<T>(rows: T[]) {
  return { success: true as const, meta: emptyMeta(), results: rows }
}

class EmptyStatement implements D1PreparedStatement {
  bind(): D1PreparedStatement {
    // The database this double stands for holds nothing, so what a statement bound to changes no answer.
    return this
  }

  async first(): Promise<null> {
    return null
  }

  async run<T>(): Promise<D1Result<T>> {
    return emptyResult<T>([])
  }

  async all<T>(): Promise<D1Result<T>> {
    return emptyResult<T>([])
  }

  async raw<T>(options?: { columnNames?: false }): Promise<T[]>
  async raw(options: { columnNames: true }): Promise<[string[], ...unknown[]]>
  async raw(options?: { columnNames?: boolean }): Promise<unknown> {
    return options?.columnNames ? [[]] : []
  }
}

/**
 * A D1 that answers every statement the way an empty database does: no rows, no changes.
 *
 * A route under test that reads a table it never seeded then sees the same `null` it would see on a
 * fresh database, and a route that writes one leaves nothing behind. For SQL that has to actually
 * run, `makeD1` in `./d1-sqlite` is the double to use.
 */
export function testD1(): D1Database {
  const database: D1Database = {
    prepare: () => new EmptyStatement(),
    async batch<T>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
      return statements.map(() => emptyResult<T>([]))
    },
    async exec(): Promise<D1ExecResult> {
      return { count: 0, duration: 0 }
    },
    withSession: () => ({
      prepare: () => new EmptyStatement(),
      async batch<T>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
        return statements.map(() => emptyResult<T>([]))
      },
      getBookmark: () => null,
    }),
    async dump(): Promise<ArrayBuffer> {
      throw new TypeError('the test D1 double has no database to dump')
    },
  }
  return database
}

class TestDurableObjectId implements DurableObjectId {
  private constructor(private readonly label: string, private readonly named?: string) {}

  static fromName(name: string): TestDurableObjectId {
    return new TestDurableObjectId(name, name)
  }

  static fromString(id: string): TestDurableObjectId {
    return new TestDurableObjectId(id)
  }

  toString(): string {
    return this.label
  }

  equals(other: DurableObjectId): boolean {
    return other.toString() === this.label
  }

  /** Only an id made from a name has one; a random or string id does not. */
  get name(): string | undefined {
    return this.named
  }
}

/**
 * A Durable Object namespace that routes `stub().fetch()` into the handler a test supplies.
 *
 * The platform hands out one instance per id; this hands out one stub per call, which is what a test
 * that builds its object inside the handler already expects.
 */
export function testDurableObjectNamespace(
  handle: (request: Request) => Response | Promise<Response>,
): DurableObjectNamespace {
  const stubFor = (id: DurableObjectId): DurableObjectStub => ({
    id,
    name: id.name,
    async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
      const request = input instanceof Request ? input : new Request(input, init)
      return await handle(request)
    },
    connect(): never {
      throw new TypeError('the test Durable Object namespace does not open sockets')
    },
  })
  const namespace: DurableObjectNamespace = {
    newUniqueId: () => TestDurableObjectId.fromString(`unique-${Math.random().toString(36).slice(2)}`),
    idFromName: (name: string) => TestDurableObjectId.fromName(name),
    idFromString: (id: string) => TestDurableObjectId.fromString(id),
    get: (id: DurableObjectId) => stubFor(id),
    getByName: (name: string) => stubFor(TestDurableObjectId.fromName(name)),
    // One in-process handler per namespace: there is no second region to route a call to.
    jurisdiction: () => namespace,
  }
  return namespace
}

/**
 * A real `Env`, with the three bindings that are never optional filled in.
 *
 * `overrides` is applied last, so a test keeps its own `FILES` fake, credential vault or setup token
 * and still cannot forget a required one: the parameter is `Partial<Env>`, which rejects a binding
 * name that does not exist and a value that does not match what `Env` declares.
 */
export function testBindings(db: D1Database, overrides: Partial<Env> = {}): Env {
  return {
    DB: db,
    ASSETS: testAssets(),
    OAUTH_KV: testKVNamespace(),
    ...overrides,
  }
}
