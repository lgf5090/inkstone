/**
 * Azure Blob Storage driver.
 *
 * Ported from `OpenList-Worker/src/backend/drivers/azure_blob`: a container is addressed through
 * the Blob REST API with SharedKey HMAC-SHA256 authentication. Directories are virtual (blob names
 * separated by `/`, `delimiter=/` in listings) and are backed by a zero-byte marker blob.
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
  driverFileName,
  driverPath,
  type HttpOptions,
} from './http'

const API_VERSION = '2021-08-06'
const PLACEHOLDER = '.openlist'
const DEFAULT_PAGE_SIZE = 1000
const MAX_LIST_PAGES = 50
const MAX_OBJECT_KEYS = 50

interface ParsedListing {
  entries: DriverEntry[]
  next: string | null
}

function normalizeRootPath(raw: string): string {
  const value = (raw || '/').trim().replace(/^\/+/, '').replace(/\/+$/, '')
  return value ? `/${value}` : '/'
}

function encodeKey(key: string): string {
  return key.split('/').map((segment) => encodeURIComponent(segment)).join('/')
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

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
  return bytes
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

async function hmacSha256Base64(data: string, key: Uint8Array): Promise<string> {
  const material = await crypto.subtle.importKey(
    'raw',
    key as unknown as BufferSource,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const signature = await crypto.subtle.sign('HMAC', material, new TextEncoder().encode(data))
  return bytesToBase64(new Uint8Array(signature))
}

function accountNameOf(endpoint: string): string {
  const withoutScheme = endpoint.replace(/^https?:\/\//, '')
  const firstDot = withoutScheme.indexOf('.')
  return (firstDot >= 0 ? withoutScheme.slice(0, firstDot) : withoutScheme).toLowerCase()
}

function parseList(xml: string, prefix: string): ParsedListing {
  const entries: DriverEntry[] = []
  const seen = new Set<string>()

  for (const block of xmlBlocks(xml, 'BlobPrefix')) {
    const raw = xmlTag(block, 'Name')
    if (!raw) continue
    const full = xmlUnescape(raw)
    if (!full.startsWith(prefix)) continue
    const name = full.slice(prefix.length).replace(/\/+$/, '')
    if (!name || name.includes('/')) continue
    if (seen.has(name)) continue
    seen.add(name)
    entries.push({ name, kind: 'folder', size: 0, modifiedAt: 0 })
  }

  for (const block of xmlBlocks(xml, 'Blob')) {
    const raw = xmlTag(block, 'Name')
    if (!raw) continue
    const key = xmlUnescape(raw)
    if (key.endsWith('/') || !key.startsWith(prefix)) continue
    const relative = key.slice(prefix.length)
    if (!relative || relative.includes('/')) continue
    if (relative === PLACEHOLDER) continue
    if (seen.has(relative)) continue
    seen.add(relative)
    entries.push({
      name: relative,
      kind: 'file',
      size: Number.parseInt(xmlTag(block, 'Content-Length') ?? '0', 10) || 0,
      modifiedAt: Date.parse(xmlTag(block, 'Last-Modified') ?? '') || 0,
      ref: key,
      mime: driverEntryMime(relative),
    })
  }

  const marker = xmlTag(xml, 'NextMarker')
  return { entries, next: marker ? xmlUnescape(marker) : null }
}

export class AzureBlobDriver extends HttpDriverBase implements MountDriver {
  readonly definition: CloudDriveDriverDefinition
  readonly capabilities: CloudDriveDriverDefinition['capabilities']

  constructor(ctx: DriverContext) {
    super(ctx)
    this.definition = findCloudDriveDriver('azure_blob')!
    this.capabilities = this.definition.capabilities
  }

  private endpoint(): string {
    const raw = this.configText('endpoint').trim()
    if (!raw) return ''
    const scheme = raw.startsWith('http://') || raw.startsWith('https://') ? raw : `https://${raw}`
    return scheme.replace(/\/+$/, '')
  }

  private container(): string {
    return this.configText('containerName').trim().replace(/^\/+|\/+$/g, '')
  }

  private accessKey(): string {
    return this.ctx.credentials.accessKey ?? ''
  }

  private rootPrefix(): string {
    return normalizeRootPath(this.configText('rootPath', '/'))
  }

  protected async login(): Promise<void> {
    if (!this.endpoint()) throw DriverError.auth('Azure Blob needs an endpoint')
    if (!this.container()) throw DriverError.auth('Azure Blob needs a container name')
    if (!this.accessKey()) throw DriverError.auth('Azure Blob needs an access key')
  }

  private rootKey(): string {
    const root = this.rootPrefix()
    return root === '/' ? '' : root.slice(1)
  }

  private objectKey(path: string, directory = false): string {
    const clean = driverPath(path)
    const relative = clean === '/' ? '' : clean.slice(1)
    let key = [this.rootKey(), relative].filter(Boolean).join('/')
    if (directory && key && !key.endsWith('/')) key += '/'
    return key
  }

  private blobUrl(key: string, query?: URLSearchParams): string {
    const url = new URL(this.endpoint())
    const base = url.pathname.replace(/\/+$/, '')
    url.pathname = `${base}/${this.container()}${key ? `/${encodeKey(key)}` : ''}`
    if (query) url.search = query.toString()
    return url.toString()
  }

  private async signature(
    method: string,
    url: URL,
    headers: Record<string, string>,
    contentLength: string,
    contentType: string,
  ): Promise<string> {
    const canonicalHeaders = Object.keys(headers)
      .filter((name) => name.startsWith('x-ms-'))
      .sort()
      .map((name) => `${name.toLowerCase()}:${(headers[name] ?? '').trim()}\n`)
      .join('')
    const resourcePath = decodeURIComponent(url.pathname)
    const query = Array.from(url.searchParams.entries())
      .map(([name, value]) => [name.toLowerCase(), value] as const)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    const canonicalResource = `/${accountNameOf(this.endpoint())}${resourcePath}` +
      (query.length ? `\n${query.map(([name, value]) => `${name}:${value}`).join('\n')}` : '')
    const range = headers.Range ?? headers.range ?? ''
    const stringToSign = [
      method.toUpperCase(),
      '',
      '',
      contentLength,
      '',
      contentType,
      '',
      '',
      '',
      '',
      '',
      range,
      canonicalHeaders + canonicalResource,
    ].join('\n')
    return await hmacSha256Base64(stringToSign, base64ToBytes(this.accessKey()))
  }

  private async send(
    method: 'GET' | 'PUT' | 'DELETE' | 'HEAD',
    key: string,
    options: {
      query?: URLSearchParams
      body?: Uint8Array
      contentType?: string
      headers?: Record<string, string>
    } = {},
  ): Promise<Response> {
    const url = new URL(this.blobUrl(key, options.query))
    const contentType = options.contentType ?? ''
    const contentLength = options.body ? String(options.body.byteLength) : ''
    const headers: Record<string, string> = {
      'x-ms-date': new Date().toUTCString(),
      'x-ms-version': API_VERSION,
      ...(options.headers ?? {}),
      ...(contentType ? { 'content-type': contentType } : {}),
      ...(contentLength ? { 'content-length': contentLength } : {}),
    }
    headers.authorization = `SharedKey ${accountNameOf(this.endpoint())}:${await this.signature(
      method,
      url,
      headers,
      contentLength,
      contentType,
    )}`
    return await this.request(url.toString(), {
      method: method as unknown as HttpOptions['method'],
      headers,
      body: options.body,
    })
  }

  private async headBlob(key: string): Promise<{ size: number; modifiedAt: number; ref: string } | null> {
    try {
      const response = await this.send('HEAD', key)
      return {
        size: Number.parseInt(response.headers.get('content-length') ?? '0', 10) || 0,
        modifiedAt: Date.parse(response.headers.get('last-modified') ?? '') || 0,
        ref: key,
      }
    } catch (error) {
      if (error instanceof DriverError && error.kind === 'not_found') return null
      throw error
    }
  }

  private async probeDirectory(prefix: string): Promise<boolean> {
    const query = new URLSearchParams({
      restype: 'container',
      comp: 'list',
      delimiter: '/',
      prefix,
      maxresults: '1',
    })
    const response = await this.send('GET', '', { query })
    const xml = await response.text()
    return xml.includes('<BlobPrefix>') || xml.includes('<Blob>')
  }

  private async listPage(prefix: string, targetPage: number, pageSize: number): Promise<ParsedListing> {
    let marker: string | null = null
    for (let page = 1; page <= Math.max(1, targetPage); page++) {
      const query = new URLSearchParams({
        restype: 'container',
        comp: 'list',
        delimiter: '/',
        prefix,
        maxresults: String(pageSize),
        ...(marker ? { marker } : {}),
      })
      const response = await this.send('GET', '', { query })
      const parsed = parseList(await response.text(), prefix)
      if (page === targetPage) return parsed
      if (!parsed.next) return { entries: [], next: null }
      marker = parsed.next
    }
    return { entries: [], next: null }
  }

  private async collectListing(prefix: string, pageSize: number): Promise<{ entries: DriverEntry[]; truncated: boolean }> {
    const entries: DriverEntry[] = []
    let marker: string | null = null
    for (let page = 1; page <= MAX_LIST_PAGES; page++) {
      const query = new URLSearchParams({
        restype: 'container',
        comp: 'list',
        delimiter: '/',
        prefix,
        maxresults: String(pageSize),
        ...(marker ? { marker } : {}),
      })
      const response = await this.send('GET', '', { query })
      const parsed = parseList(await response.text(), prefix)
      entries.push(...parsed.entries)
      if (!parsed.next) return { entries, truncated: false }
      marker = parsed.next
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
    if (clean === '/') return { name: 'root', kind: 'folder', size: 0, modifiedAt: 0, ref: '' }
    const key = this.objectKey(clean)
    const head = await this.headBlob(key)
    if (head) {
      const name = driverFileName(clean)
      return { name, kind: 'file', size: head.size, modifiedAt: head.modifiedAt, ref: key, mime: driverEntryMime(name) }
    }
    if (await this.probeDirectory(this.objectKey(clean, true))) {
      return { name: driverFileName(clean), kind: 'folder', size: 0, modifiedAt: 0, ref: key }
    }
    throw DriverError.notFound(`Blob not found: ${clean}`)
  }

  async read(path: string, range?: string | null): Promise<Response> {
    const clean = driverPath(path)
    await this.authenticate()
    if (clean === '/') throw DriverError.unsupported('A folder cannot be read as a file')
    return await this.send('GET', this.objectKey(clean), {
      headers: range ? { Range: range } : {},
    })
  }

  async upload(path: string, body: Uint8Array | ReadableStream, options: DriverUploadOptions): Promise<void> {
    const clean = driverPath(path)
    await this.authenticate()
    const bytes = await asBytes(body)
    if (bytes.byteLength !== options.size) {
      throw DriverError.invalid('The upload body does not match the declared size')
    }
    await this.send('PUT', this.objectKey(clean), {
      body: bytes,
      contentType: options.contentType || driverEntryMime(driverFileName(clean)),
      headers: { 'x-ms-blob-type': 'BlockBlob' },
    })
    options.onProgress?.(bytes.byteLength, bytes.byteLength)
  }

  async mkdir(path: string): Promise<void> {
    const clean = driverPath(path)
    await this.authenticate()
    if (clean === '/') return
    await this.send('PUT', this.objectKey(clean, true), {
      body: new Uint8Array(0),
      contentType: 'application/octet-stream',
      headers: { 'x-ms-blob-type': 'BlockBlob', 'x-ms-meta-hdi_isfolder': 'true' },
    })
  }

  async rename(path: string, newName: string): Promise<void> {
    const clean = driverPath(path)
    const parent = clean.slice(0, clean.lastIndexOf('/')) || '/'
    const target = driverPath(`${parent === '/' ? '' : parent}/${newName}`)
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
    await this.authenticate()
    if (clean === '/') return null
    const key = this.objectKey(clean)
    const expiry = new Date(Date.now() + 4 * 3600 * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')
    const canonicalResource = `/blob/${accountNameOf(this.endpoint())}/${this.container()}/${key}`
    const stringToSign = [
      'r', '', expiry, canonicalResource, '', '', '', API_VERSION, 'b',
      '', '', '', '', '', '', '',
    ].join('\n')
    const signature = encodeURIComponent(await hmacSha256Base64(stringToSign, base64ToBytes(this.accessKey())))
    const url = new URL(this.blobUrl(key))
    url.searchParams.set('sp', 'r')
    url.searchParams.set('se', expiry)
    url.searchParams.set('sv', API_VERSION)
    url.searchParams.set('sr', 'b')
    url.searchParams.set('sig', signature)
    return url.toString()
  }

  async test(): Promise<{ ok: boolean; message: string }> {
    try {
      await this.authenticate()
      const query = new URLSearchParams({
        restype: 'container',
        comp: 'list',
        maxresults: '1',
        prefix: this.objectKey('/', true),
      })
      await this.send('GET', '', { query })
      return { ok: true, message: 'Azure Blob is reachable' }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : 'Azure Blob is unavailable' }
    }
  }

  private async copyBlob(source: string, target: string): Promise<void> {
    const sourceUrl = new URL(this.blobUrl(source)).toString()
    await this.send('PUT', target, {
      body: new Uint8Array(0),
      contentType: 'application/octet-stream',
      headers: { 'x-ms-blob-type': 'BlockBlob', 'x-ms-copy-source': sourceUrl },
    })
  }

  private async deleteBlob(key: string): Promise<void> {
    await this.send('DELETE', key)
  }

  private async copyTree(source: string, target: string): Promise<void> {
    const head = await this.headBlob(source)
    if (head) {
      await this.copyBlob(source, target)
      return
    }
    const keys = await this.listKeys(`${source}/`)
    if (keys.length === 0) throw DriverError.notFound(`Blob not found: ${source}`)
    for (const key of keys) {
      const relative = key.slice(source.length + 1)
      await this.copyBlob(key, `${target}/${relative}`)
    }
  }

  private async deleteTree(key: string): Promise<void> {
    const head = await this.headBlob(key)
    if (head) {
      await this.deleteBlob(key)
      return
    }
    const keys = await this.listKeys(`${key}/`)
    if (keys.length === 0) throw DriverError.notFound(`Blob not found: ${key}`)
    for (const child of keys) await this.deleteBlob(child)
  }

  private async listKeys(prefix: string): Promise<string[]> {
    const keys: string[] = []
    let marker: string | null = null
    for (let page = 1; page <= MAX_OBJECT_KEYS; page++) {
      const query = new URLSearchParams({
        restype: 'container',
        comp: 'list',
        prefix,
        maxresults: '1000',
        ...(marker ? { marker } : {}),
      })
      const response = await this.send('GET', '', { query })
      const xml = await response.text()
      for (const block of xmlBlocks(xml, 'Blob')) {
        const name = xmlTag(block, 'Name')
        if (name) keys.push(xmlUnescape(name))
      }
      const next = xmlTag(xml, 'NextMarker')
      if (!next) break
      marker = xmlUnescape(next)
    }
    return keys
  }
}

export function createAzureBlobDriver(ctx: DriverContext): MountDriver {
  return new AzureBlobDriver(ctx)
}
