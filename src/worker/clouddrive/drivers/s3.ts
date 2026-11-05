/**
 * S3-compatible object storage driver.
 *
 * Ported from `OpenList-Worker/src/backend/drivers/s3`: ListObjectsV2/v1 pagination, HEAD/GET
 * object reads (Range forwarded untouched), PUT + multipart upload, server-side COPY, DELETE,
 * presigned GET links and a zero-byte placeholder object for directories. Bucket keys are prefixed
 * with the configured `rootPath`; every public method validates the mount path first.
 */
import { findCloudDriveDriver, type CloudDriveDriverDefinition } from '@shared/clouddrive/drivers'
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
} from './contract'
import {
  HttpDriverBase,
  driverChildPath,
  driverFileName,
  driverParentPath,
  driverPath,
  uploadInParts,
  type HttpOptions,
} from './http'

const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
const PLACEHOLDER = '.openlist'
const MULTIPART_THRESHOLD = 8 * 1024 * 1024
const MAX_LIST_PAGES = 50
const MAX_OBJECT_KEYS = 50
const DEFAULT_PAGE_SIZE = 1000

interface HeadResult {
  size: number
  modifiedAt: number
  etag: string
}

interface ParsedListing {
  entries: DriverEntry[]
  next: string | null
}

function normalizeRootPath(raw: string): string {
  const value = (raw || '/').trim().replace(/^\/+/, '').replace(/\/+$/, '')
  return value ? `/${value}` : '/'
}

function encodeKey(key: string): string {
  return key
    .split('/')
    .filter((segment, index) => index > 0 || segment !== '')
    .map((segment) => encodeURIComponent(segment))
    .join('/')
}

function xmlTag(block: string, tag: string): string | null {
  const match = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'))
  return match ? match[1]!.trim() : null
}

function xmlBlocks(xml: string, tag: string): string[] {
  const blocks: string[] = []
  const regex = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'gi')
  let match: RegExpExecArray | null
  while ((match = regex.exec(xml)) !== null) blocks.push(match[1]!)
  return blocks
}

function xmlUnescape(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
}

function hex(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  let out = ''
  for (const byte of view) out += byte.toString(16).padStart(2, '0')
  return out
}

async function sha256Hex(data: string | Uint8Array): Promise<string> {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data
  return hex(await crypto.subtle.digest('SHA-256', bytes))
}

async function hmacSha256(key: string | Uint8Array, data: string | Uint8Array): Promise<Uint8Array> {
  const keyBytes = typeof key === 'string' ? new TextEncoder().encode(key) : key
  const dataBytes = typeof data === 'string' ? new TextEncoder().encode(data) : data
  const material = await crypto.subtle.importKey(
    'raw',
    keyBytes as unknown as BufferSource,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  return new Uint8Array(await crypto.subtle.sign('HMAC', material, dataBytes as unknown as BufferSource))
}

function rfc3986Encode(value: string, encodeSlash = true): string {
  const encoded = encodeURIComponent(value).replace(/[!'()*]/g, (character) => (
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  ))
  return encodeSlash ? encoded : encoded.replace(/%2F/g, '/')
}

function amzDates(date = new Date()): { amzDate: string; dateStamp: string } {
  const pad = (value: number): string => String(value).padStart(2, '0')
  const dateStamp = `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}`
  return {
    amzDate: `${dateStamp}T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`,
    dateStamp,
  }
}

function canonicalUri(url: URL): string {
  let decoded = url.pathname || '/'
  try {
    decoded = decodeURIComponent(decoded)
  } catch {
    // Keep the already-encoded path when it contains a stray percent sign.
  }
  return rfc3986Encode(decoded, false)
}

function canonicalQuery(url: URL, exclude: string[] = []): string {
  const pairs: Array<[string, string]> = []
  url.searchParams.forEach((value, key) => {
    if (exclude.includes(key.toLowerCase())) return
    pairs.push([key, value])
  })
  pairs.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
  return pairs
    .map(([key, value]) => `${rfc3986Encode(key)}=${rfc3986Encode(value)}`)
    .join('&')
}

async function signingKey(secret: string, dateStamp: string, region: string): Promise<Uint8Array> {
  const date = await hmacSha256(`AWS4${secret}`, dateStamp)
  const regional = await hmacSha256(date, region)
  return hmacSha256(await hmacSha256(regional, 's3'), 'aws4_request')
}

interface SignOptions {
  method: string
  url: string
  region: string
  accessKeyId: string
  secretAccessKey: string
  sessionToken?: string
  headers?: Record<string, string>
  payload: Uint8Array | null
}

async function signS3Request(options: SignOptions): Promise<Record<string, string>> {
  const { amzDate, dateStamp } = amzDates()
  const url = new URL(options.url)
  const payloadHash = options.payload ? await sha256Hex(options.payload) : EMPTY_SHA256
  const headers: Record<string, string> = {
    host: url.host,
    'x-amz-date': amzDate,
    'x-amz-content-sha256': payloadHash,
    ...(options.sessionToken ? { 'x-amz-security-token': options.sessionToken } : {}),
    ...(options.headers ?? {}),
  }
  const names = Object.keys(headers).map((key) => key.toLowerCase()).sort()
  const canonicalHeaders = names
    .map((name) => {
      const original = Object.keys(headers).find((key) => key.toLowerCase() === name)!
      return `${name}:${(headers[original] ?? '').trim().replace(/\s+/g, ' ')}\n`
    })
    .join('')
  const signedHeaders = names.join(';')
  const canonicalRequest = [
    options.method.toUpperCase(),
    canonicalUri(url),
    canonicalQuery(url),
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n')
  const scope = `${dateStamp}/${options.region}/s3/aws4_request`
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    scope,
    await sha256Hex(canonicalRequest),
  ].join('\n')
  const signature = hex(await hmacSha256(await signingKey(options.secretAccessKey, dateStamp, options.region), stringToSign))
  return {
    ...headers,
    authorization: `AWS4-HMAC-SHA256 Credential=${options.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  }
}

async function presignS3Url(options: {
  url: string
  region: string
  accessKeyId: string
  secretAccessKey: string
  sessionToken?: string
  expiresSeconds: number
}): Promise<string> {
  const { amzDate, dateStamp } = amzDates()
  const url = new URL(options.url)
  const scope = `${dateStamp}/${options.region}/s3/aws4_request`
  url.searchParams.set('X-Amz-Algorithm', 'AWS4-HMAC-SHA256')
  url.searchParams.set('X-Amz-Credential', `${options.accessKeyId}/${scope}`)
  url.searchParams.set('X-Amz-Date', amzDate)
  url.searchParams.set('X-Amz-Expires', String(options.expiresSeconds))
  url.searchParams.set('X-Amz-SignedHeaders', 'host')
  if (options.sessionToken) url.searchParams.set('X-Amz-Security-Token', options.sessionToken)
  const canonicalRequest = [
    'GET',
    canonicalUri(url),
    canonicalQuery(url, ['x-amz-signature']),
    `host:${url.host}\n`,
    'host',
    'UNSIGNED-PAYLOAD',
  ].join('\n')
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    scope,
    await sha256Hex(canonicalRequest),
  ].join('\n')
  const signature = hex(await hmacSha256(await signingKey(options.secretAccessKey, dateStamp, options.region), stringToSign))
  url.searchParams.set('X-Amz-Signature', signature)
  return url.toString()
}

function listingName(key: string, prefix: string): string {
  const relative = prefix && key.startsWith(prefix) ? key.slice(prefix.length) : key
  return relative.replace(/\/+$/, '').split('/').filter(Boolean).pop() ?? ''
}

function parseListing(xml: string, prefix: string, placeholder: string, version: 'v1' | 'v2'): ParsedListing {
  const entries: DriverEntry[] = []
  const seen = new Set<string>()

  for (const block of xmlBlocks(xml, 'CommonPrefixes')) {
    const raw = xmlTag(block, 'Prefix')
    if (!raw) continue
    const decoded = xmlUnescape(raw)
    const name = listingName(decoded, prefix)
    if (!name || seen.has(name)) continue
    seen.add(name)
    entries.push({ name, kind: 'folder', size: 0, modifiedAt: 0, ref: decoded })
  }

  for (const block of xmlBlocks(xml, 'Contents')) {
    const raw = xmlTag(block, 'Key')
    if (!raw) continue
    const key = xmlUnescape(raw)
    if (key.endsWith('/')) continue
    const name = listingName(key, prefix)
    if (!name || name === placeholder || seen.has(name)) continue
    seen.add(name)
    entries.push({
      name,
      kind: 'file',
      size: Number.parseInt(xmlTag(block, 'Size') ?? '0', 10) || 0,
      modifiedAt: Date.parse(xmlTag(block, 'LastModified') ?? '') || 0,
      ref: key,
      mime: driverEntryMime(name),
    })
  }

  const truncated = (xmlTag(xml, 'IsTruncated') ?? '').toLowerCase() === 'true'
  const next = version === 'v2'
    ? xmlTag(xml, 'NextContinuationToken')
    : (xmlTag(xml, 'NextMarker') ?? (truncated ? entries.at(-1)?.ref ?? null : null))
  return { entries, next: truncated ? next : null }
}

function parseKeys(xml: string): string[] {
  return xmlBlocks(xml, 'Contents')
    .map((block) => xmlTag(block, 'Key'))
    .filter((key): key is string => Boolean(key))
    .map((key) => xmlUnescape(key))
}

interface ListPage {
  entries: DriverEntry[]
  next: string | null
}

export class S3Driver extends HttpDriverBase implements MountDriver {
  readonly definition: CloudDriveDriverDefinition
  readonly capabilities: CloudDriveDriverDefinition['capabilities']

  constructor(ctx: DriverContext, driverId = 's3') {
    super(ctx)
    this.definition = findCloudDriveDriver(driverId)!
    this.capabilities = this.definition.capabilities
  }

  protected endpoint(): string {
    const raw = this.configText('endpoint').trim()
    if (!raw) return ''
    const scheme = raw.startsWith('http://') || raw.startsWith('https://') ? raw : `https://${raw}`
    return scheme.replace(/\/+$/, '')
  }

  protected bucket(): string {
    return (this.configText('bucket') || this.configText('bucketName')).trim()
  }

  protected region(): string {
    return this.configText('region', 'auto').trim() || 'auto'
  }

  protected accessKeyId(): string {
    return this.ctx.credentials.accessKeyId ?? ''
  }

  protected secretAccessKey(): string {
    return this.ctx.credentials.secretAccessKey ?? ''
  }

  protected sessionToken(): string {
    return this.ctx.credentials.sessionToken ?? ''
  }

  protected rootPrefix(): string {
    return normalizeRootPath(this.configText('rootPath', '/'))
  }

  protected pathStyle(): boolean {
    return this.ctx.config.pathStyle !== false
  }

  protected customHost(): string {
    return this.configText('customHost').trim()
  }

  protected placeholder(): string {
    return PLACEHOLDER
  }

  protected listVersion(): 'v1' | 'v2' {
    return this.configText('listObjectVersion', 'v2').toLowerCase() === 'v1' ? 'v1' : 'v2'
  }

  protected async login(): Promise<void> {
    if (!this.endpoint()) throw DriverError.auth('S3 needs an endpoint')
    if (!this.bucket()) throw DriverError.auth('S3 needs a bucket')
    if (!this.accessKeyId() || !this.secretAccessKey()) {
      throw DriverError.auth('S3 needs an access key id and a secret access key')
    }
  }

  private rootKey(): string {
    const root = this.rootPrefix()
    return root === '/' ? '' : root.slice(1)
  }

  protected objectKey(path: string, directory = false): string {
    const clean = driverPath(path)
    const relative = clean === '/' ? '' : clean.slice(1)
    let key = [this.rootKey(), relative].filter(Boolean).join('/')
    if (directory && key && !key.endsWith('/')) key += '/'
    return key
  }

  protected urlFor(key: string, params?: Record<string, string>): string {
    const url = new URL(this.endpoint())
    const basePath = url.pathname.replace(/\/+$/, '')
    const encodedKey = encodeKey(key)
    if (this.pathStyle()) {
      const path = [basePath, this.bucket(), encodedKey].filter(Boolean).join('/')
      url.pathname = `/${path.replace(/^\/+/, '')}`
    } else {
      url.hostname = `${this.bucket()}.${url.hostname}`
      const path = [basePath, encodedKey].filter(Boolean).join('/')
      url.pathname = `/${path.replace(/^\/+/, '')}`
    }
    if (params) {
      for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value)
    }
    return url.toString()
  }

  private async send(
    method: string,
    url: string,
    body: Uint8Array | null = null,
    headers: Record<string, string> = {},
  ): Promise<Response> {
    const signed = await signS3Request({
      method,
      url,
      region: this.region(),
      accessKeyId: this.accessKeyId(),
      secretAccessKey: this.secretAccessKey(),
      sessionToken: this.sessionToken() || undefined,
      headers,
      payload: body,
    })
    return await this.request(url, {
      method: method as unknown as HttpOptions['method'],
      headers: signed,
      body: body ?? undefined,
      asRequest: true,
    })
  }

  private async headObject(key: string): Promise<HeadResult | null> {
    try {
      const response = await this.send('HEAD', this.urlFor(key))
      return {
        size: Number.parseInt(response.headers.get('content-length') ?? '0', 10) || 0,
        modifiedAt: Date.parse(response.headers.get('last-modified') ?? '') || 0,
        etag: (response.headers.get('etag') ?? '').replace(/"/g, ''),
      }
    } catch (error) {
      if (error instanceof DriverError && error.kind === 'not_found') return null
      throw error
    }
  }

  private async probeDirectory(prefix: string): Promise<boolean> {
    const params: Record<string, string> = { prefix, 'max-keys': '1' }
    if (this.listVersion() === 'v2') params['list-type'] = '2'
    const response = await this.send('GET', this.urlFor('', params))
    const xml = await response.text()
    return xml.includes('<Contents>') || xml.includes('<CommonPrefixes>')
  }

  private listParams(prefix: string, pageSize: number, cursor: string | null): Record<string, string> {
    const version = this.listVersion()
    const params: Record<string, string> = {}
    if (version === 'v2') params['list-type'] = '2'
    params.delimiter = '/'
    params['max-keys'] = String(pageSize)
    if (prefix) params.prefix = prefix
    if (cursor) {
      if (version === 'v2') params['continuation-token'] = cursor
      else params.marker = cursor
    }
    return params
  }

  private async listPage(prefix: string, targetPage: number, pageSize: number): Promise<ListPage> {
    let cursor: string | null = null
    for (let page = 1; page <= Math.max(1, targetPage); page++) {
      const params = this.listParams(prefix, pageSize, cursor)
      const response = await this.send('GET', this.urlFor('', params))
      const xml = await response.text()
      const parsed = parseListing(xml, prefix, this.placeholder(), this.listVersion())
      if (page === targetPage) return parsed
      if (!parsed.next) return { entries: [], next: null }
      cursor = parsed.next
    }
    return { entries: [], next: null }
  }

  private async collectListing(prefix: string, pageSize: number): Promise<{ entries: DriverEntry[]; truncated: boolean }> {
    const entries: DriverEntry[] = []
    const version = this.listVersion()
    let cursor: string | null = null
    for (let page = 1; page <= MAX_LIST_PAGES; page++) {
      const response = await this.send('GET', this.urlFor('', this.listParams(prefix, pageSize, cursor)))
      const parsed = parseListing(await response.text(), prefix, this.placeholder(), version)
      entries.push(...parsed.entries)
      if (!parsed.next) return { entries, truncated: false }
      cursor = parsed.next
    }
    return { entries, truncated: true }
  }

  async list(path: string, options: DriverListOptions = {}): Promise<DriverListResult> {
    const clean = driverPath(path)
    await this.authenticate()
    const prefix = this.objectKey(clean, true)
    const pageSize = Math.min(DEFAULT_PAGE_SIZE, Math.max(1, options.pageSize ?? DEFAULT_PAGE_SIZE))
    if (options.page !== undefined) {
      const page = await this.listPage(prefix, Math.max(1, options.page), pageSize)
      return { entries: page.entries, cursor: page.next, truncated: page.next !== null }
    }
    const collected = await this.collectListing(prefix, pageSize)
    return { entries: collected.entries, cursor: null, truncated: collected.truncated }
  }

  async stat(path: string): Promise<DriverEntry> {
    const clean = driverPath(path)
    await this.authenticate()
    if (clean === '/') {
      return { name: 'root', kind: 'folder', size: 0, modifiedAt: 0, ref: '' }
    }
    const key = this.objectKey(clean)
    const head = await this.headObject(key)
    if (head) {
      const name = driverFileName(clean)
      return { name, kind: 'file', size: head.size, modifiedAt: head.modifiedAt, ref: key, mime: driverEntryMime(name) }
    }
    if (await this.probeDirectory(this.objectKey(clean, true))) {
      return { name: driverFileName(clean), kind: 'folder', size: 0, modifiedAt: 0, ref: key }
    }
    throw DriverError.notFound(`Object not found: ${clean}`)
  }

  async read(path: string, range?: string | null): Promise<Response> {
    const clean = driverPath(path)
    await this.authenticate()
    if (clean === '/') throw DriverError.unsupported('A folder cannot be read as a file')
    return await this.send(
      'GET',
      this.urlFor(this.objectKey(clean)),
      null,
      range ? { Range: range } : {},
    )
  }

  async upload(path: string, body: Uint8Array | ReadableStream, options: DriverUploadOptions): Promise<void> {
    const clean = driverPath(path)
    await this.authenticate()
    const bytes = await asBytes(body)
    if (bytes.byteLength !== options.size) {
      throw DriverError.invalid('The upload body does not match the declared size')
    }
    const key = this.objectKey(clean)
    const contentType = options.contentType || driverEntryMime(driverFileName(clean))
    if (bytes.byteLength <= MULTIPART_THRESHOLD) {
      await this.send('PUT', this.urlFor(key), bytes, { 'content-type': contentType })
      options.onProgress?.(bytes.byteLength, bytes.byteLength)
      return
    }
    await this.multipartUpload(key, bytes, contentType, options)
  }

  private async multipartUpload(
    key: string,
    bytes: Uint8Array,
    contentType: string,
    options: DriverUploadOptions,
  ): Promise<void> {
    const partSize = Math.max(MULTIPART_THRESHOLD, Math.ceil(bytes.byteLength / 10_000))
    const init = await this.send('POST', this.urlFor(key, { uploads: '' }), null, {
      'content-type': contentType,
    })
    const uploadId = xmlTag(await init.text(), 'UploadId')
    if (!uploadId) throw DriverError.upstream('S3 did not return a multipart upload id')
    const parts: Array<{ number: number; etag: string }> = []
    try {
      await uploadInParts({
        size: bytes.byteLength,
        partSize,
        concurrency: 1,
        uploadPart: async (partNumber, start, end) => {
          const part = await this.send(
            'PUT',
            this.urlFor(key, { partNumber: String(partNumber), uploadId }),
            bytes.subarray(start, end),
          )
          const etag = (part.headers.get('etag') ?? '').replace(/"/g, '')
          if (!etag) throw DriverError.upstream(`S3 did not return an ETag for part ${partNumber}`)
          parts.push({ number: partNumber, etag })
          options.onProgress?.(end, bytes.byteLength)
        },
        complete: async () => {
          const body = [
            '<CompleteMultipartUpload>',
            ...parts.map((part) => (
              `<Part><PartNumber>${part.number}</PartNumber><ETag>${part.etag}</ETag></Part>`
            )),
            '</CompleteMultipartUpload>',
          ].join('')
          await this.send('POST', this.urlFor(key, { uploadId }), new TextEncoder().encode(body), {
            'content-type': 'application/xml',
          })
        },
      })
    } catch (error) {
      await this.send('DELETE', this.urlFor(key, { uploadId })).catch(() => undefined)
      throw error
    }
  }

  async mkdir(path: string): Promise<void> {
    const clean = driverPath(path)
    await this.authenticate()
    if (clean === '/') return
    const key = `${this.objectKey(clean)}/${this.placeholder()}`
    await this.send('PUT', this.urlFor(key), new Uint8Array(0), {
      'content-type': 'application/octet-stream',
    })
  }

  async rename(path: string, newName: string): Promise<void> {
    const clean = driverPath(path)
    const target = driverPath(driverChildPath(driverParentPath(clean), newName))
    await this.authenticate()
    await this.copyTree(this.objectKey(clean), this.objectKey(target))
    await this.deleteTree(this.objectKey(clean))
  }

  async move(fromPath: string, toPath: string): Promise<void> {
    const from = driverPath(fromPath)
    const to = driverPath(toPath)
    await this.authenticate()
    await this.copyTree(this.objectKey(from), this.objectKey(to))
    await this.deleteTree(this.objectKey(from))
  }

  async copy(fromPath: string, toPath: string): Promise<void> {
    const from = driverPath(fromPath)
    const to = driverPath(toPath)
    await this.authenticate()
    await this.copyTree(this.objectKey(from), this.objectKey(to))
  }

  async remove(path: string): Promise<void> {
    const clean = driverPath(path)
    await this.authenticate()
    if (clean === '/') throw DriverError.unsupported('The mount root cannot be removed')
    await this.deleteTree(this.objectKey(clean))
  }

  async directLink(path: string): Promise<string | null> {
    const clean = driverPath(path)
    const key = this.objectKey(clean)
    if (clean === '/') return null
    const customHost = this.customHost()
    if (customHost) {
      const raw = customHost.startsWith('http://') || customHost.startsWith('https://')
        ? customHost
        : `https://${customHost}`
      const url = new URL(raw)
      const base = url.pathname.replace(/\/+$/, '')
      url.pathname = `${base}/${encodeKey(key)}`
      return url.toString()
    }
    await this.authenticate()
    const expires = Math.min(86_400, Math.max(60, Math.round(this.ctx.directLinkExpires ?? 300)))
    return await presignS3Url({
      url: this.urlFor(key),
      region: this.region(),
      accessKeyId: this.accessKeyId(),
      secretAccessKey: this.secretAccessKey(),
      sessionToken: this.sessionToken() || undefined,
      expiresSeconds: expires,
    })
  }

  async test(): Promise<{ ok: boolean; message: string }> {
    try {
      await this.authenticate()
      const params: Record<string, string> = { prefix: this.objectKey('/', true), 'max-keys': '1' }
      if (this.listVersion() === 'v2') params['list-type'] = '2'
      await this.send('GET', this.urlFor('', params))
      return { ok: true, message: `${this.definition.id} is reachable` }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : 'The storage is unavailable' }
    }
  }

  private async copyObject(source: string, target: string): Promise<void> {
    await this.send('PUT', this.urlFor(target), null, {
      'x-amz-copy-source': encodeKey(`${this.bucket()}/${source}`),
    })
  }

  private async copyTree(source: string, target: string): Promise<void> {
    const head = await this.headObject(source)
    if (head) {
      await this.copyObject(source, target)
      return
    }
    const keys = await this.listKeys(`${source}/`)
    if (keys.length === 0) throw DriverError.notFound(`Object not found: ${source}`)
    for (const key of keys) {
      const relative = key.slice(source.length + 1)
      await this.copyObject(key, `${target}/${relative}`)
    }
  }

  private async deleteTree(key: string): Promise<void> {
    const head = await this.headObject(key)
    if (head) {
      await this.deleteObject(key)
      return
    }
    const prefix = key.endsWith('/') ? key : `${key}/`
    const keys = await this.listKeys(prefix)
    if (keys.length === 0) throw DriverError.notFound(`Object not found: ${key}`)
    for (const child of keys) await this.deleteObject(child)
  }

  private async deleteObject(key: string): Promise<void> {
    await this.send('DELETE', this.urlFor(key))
  }

  /** Lists every object key below a prefix (no delimiter), following continuation pages. */
  private async listKeys(prefix: string): Promise<string[]> {
    const keys: string[] = []
    const version = this.listVersion()
    let cursor: string | null = null
    for (let page = 1; page <= MAX_OBJECT_KEYS; page++) {
      const params: Record<string, string> = {
        prefix,
        'max-keys': '1000',
        ...(version === 'v2' ? { 'list-type': '2' } : {}),
        ...(cursor
          ? version === 'v2' ? { 'continuation-token': cursor } : { marker: cursor }
          : {}),
      }
      const response = await this.send('GET', this.urlFor('', params))
      const xml = await response.text()
      const pageKeys = parseKeys(xml)
      keys.push(...pageKeys)
      const truncated = (xmlTag(xml, 'IsTruncated') ?? '').toLowerCase() === 'true'
      const next = version === 'v2'
        ? xmlTag(xml, 'NextContinuationToken')
        : (xmlTag(xml, 'NextMarker') ?? (truncated ? pageKeys.at(-1) ?? null : null))
      if (!truncated || !next) break
      cursor = next
    }
    return keys
  }
}

export function createS3Driver(ctx: DriverContext): MountDriver {
  return new S3Driver(ctx)
}
