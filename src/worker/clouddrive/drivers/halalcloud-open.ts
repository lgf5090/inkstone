/**
 * HalalCloud Open driver.
 *
 * Ported from `OpenList-Worker/src/backend/drivers/halalcloud_open`. Every request is a JSON POST
 * signed with the HL6-HMAC-SHA256 variant of AWS SigV4 (WebCrypto). The access token is rotated from
 * the refresh token; concurrent callers share one single flight and write back with a compare-and-swap.
 */
import { findCloudDriveDriver } from '@shared/clouddrive/drivers'
import {
  DriverError,
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
  collectPages,
  driverFileName,
  driverParentPath,
  driverPath,
} from './http'
import { singleFlightRefresh } from './token'

const DEFAULT_HOST = 'openapi.2dland.cn'
const LIST_PATH = '/v6/userfile/list'
const DOWNLOAD_ADDRESS_PATH = '/v6/userfile/get_direct_download_address'
const CREATE_PATH = '/v6/userfile/create'
const RENAME_PATH = '/v6/userfile/rename'
const MOVE_PATH = '/v6/userfile/move'
const COPY_PATH = '/v6/userfile/copy'
const DELETE_PATH = '/v6/userfile/delete'
const REFRESH_PATH = '/v6/oauth/refresh_token'
const SIGN_ALGORITHM = 'HL6-HMAC-SHA256'
const SIGN_PREFIX = 'HL6'
const REQUEST_SUFFIX = 'hl6_request'
const PAGE_SIZE = 100
const MAX_LIST_PAGES = 50
const REFRESH_LEAD_MS = 60_000

interface HCloudFile {
  identity?: string
  parent?: string
  name?: string
  path?: string
  mime_type?: string
  size?: string | number
  type?: string | number
  create_ts?: string | number
  update_ts?: string | number
  dir?: boolean
}

interface HCloudFileListResponse {
  files?: HCloudFile[]
  list_info?: { limit?: number; token?: string }
  message?: string
  msg?: string
}

interface HCloudDownloadAddressResponse {
  download_address?: string
  file_size?: string | number
  name?: string
  path?: string
}

interface HCloudTokenResponse {
  access_token?: string
  refresh_token?: string
  expires_in?: number
  message?: string
  msg?: string
}

function toUtf8(value: string): Uint8Array {
  return new TextEncoder().encode(value)
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

async function sha256Hex(data: string | Uint8Array): Promise<string> {
  const bytes = typeof data === 'string' ? toUtf8(data) : data
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource)
  return bytesToHex(new Uint8Array(digest))
}

async function hmacSha256(data: Uint8Array, key: Uint8Array): Promise<Uint8Array> {
  const material = await crypto.subtle.importKey(
    'raw',
    key as BufferSource,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const signature = await crypto.subtle.sign('HMAC', material, data as BufferSource)
  return new Uint8Array(signature)
}

function rfc3986Encode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`)
}

interface SignInput {
  apiHost: string
  secretId: string
  secretKey: string
  accessToken: string
  method: string
  apiPath: string
  bodyRaw: Uint8Array
  query?: Record<string, string>
}

interface SignOutput {
  headers: Record<string, string>
  url: string
}

/** HL6-HMAC-SHA256, the AWS SigV4 variant the HalalCloud SDK publishes. */
export async function hcloudSign(input: SignInput): Promise<SignOutput> {
  const now = new Date()
  const dateString = now.toISOString().slice(0, 10)
  const timestamp = now.toISOString()
  const nonce = (
    BigInt(Math.floor(now.getTime())) * 1000000n + BigInt(Math.floor(Math.random() * 1000000))
  ).toString(36)

  const hasBody = input.bodyRaw.length > 0
  const headers: Record<string, string> = {
    host: input.apiHost,
    'x-hl-nonce': nonce,
    'x-hl-timestamp': timestamp,
  }
  const headersToSign: string[] = []
  if (hasBody) {
    headers['content-type'] = 'application/json; charset=utf-8'
    headersToSign.push('content-type')
  }

  const sortedHeaders = [...headersToSign].sort()
  const canonicalHeaders = sortedHeaders.map((header) => `${header}:${headers[header]}\n`).join('')
  const signedHeaders = sortedHeaders.join(';')

  let sortedQuery = ''
  if (input.query && Object.keys(input.query).length > 0) {
    sortedQuery = Object.keys(input.query)
      .sort()
      .map((key) => `${rfc3986Encode(key)}=${rfc3986Encode(input.query?.[key] ?? '')}`)
      .join('&')
  }

  const bodyHash = await sha256Hex(input.bodyRaw)
  const canonicalRequest = [
    input.method,
    input.apiPath,
    sortedQuery,
    canonicalHeaders,
    signedHeaders,
    bodyHash,
  ].join('\n')

  const credentialScope = `${dateString}/${input.accessToken}/${REQUEST_SUFFIX}`
  const stringToSign = [
    SIGN_ALGORITHM,
    timestamp,
    credentialScope,
    await sha256Hex(canonicalRequest),
  ].join('\n')

  const secretKey = toUtf8(SIGN_PREFIX + input.secretKey)
  const dateKey = await hmacSha256(toUtf8(dateString), secretKey)
  const tokenKey = await hmacSha256(toUtf8(input.accessToken), dateKey)
  const signingKey = await hmacSha256(toUtf8(REQUEST_SUFFIX), tokenKey)
  const signature = bytesToHex(await hmacSha256(toUtf8(stringToSign), signingKey))

  headers.authorization = `${SIGN_ALGORITHM} Credential=${input.secretId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`
  const url = `https://${input.apiHost}${input.apiPath}${sortedQuery ? `?${sortedQuery}` : ''}`
  return { headers, url }
}

function normalizeRoot(value: string): string {
  if (!value || value === '/') return '/'
  const path = value.startsWith('/') ? value : `/${value}`
  return path.replace(/\/+$/, '') || '/'
}

function fileEntry(file: HCloudFile): DriverEntry {
  const folder = file.dir === true
  const name = file.name || String(file.path ?? '').slice(String(file.path ?? '').lastIndexOf('/') + 1)
  const seconds = Number(file.update_ts || file.create_ts) || 0
  return {
    name,
    kind: folder ? 'folder' : 'file',
    size: folder ? 0 : Number(file.size) || 0,
    modifiedAt: seconds > 0 ? seconds * 1000 : 0,
    ref: file.identity || file.path,
    mime: folder ? 'application/octet-stream' : (file.mime_type || driverEntryMime(name)),
  }
}

export class HalalCloudOpenDriver extends HttpDriverBase implements MountDriver {
  readonly definition = findCloudDriveDriver('halalcloud_open')!
  readonly capabilities = this.definition.capabilities
  private readonly host: string
  private readonly rootPath: string

  constructor(ctx: DriverContext) {
    super(ctx)
    const host = this.configText('host').trim().replace(/^https?:\/\//, '').replace(/\/+$/, '')
    this.host = host || DEFAULT_HOST
    this.rootPath = normalizeRoot(this.configText('rootFolderId').trim())
  }

  private credential(key: string): string {
    return String(this.ctx.credentials[key] ?? '')
  }

  private get accessToken(): string {
    return this.credential('accessToken')
  }

  private get refreshToken(): string {
    return this.credential('refreshToken')
  }

  private expiresAt(): number {
    return Number(this.credential('expiresAt')) || 0
  }

  private usable(): boolean {
    if (!this.accessToken) return false
    const expiresAt = this.expiresAt()
    if (!expiresAt) return true
    return expiresAt - Date.now() > REFRESH_LEAD_MS
  }

  private invalidate(): void {
    this.ctx.credentials.accessToken = ''
    this.ctx.credentials.expiresAt = '0'
  }

  protected async login(force: boolean): Promise<void> {
    await this.token(force)
  }

  private async token(force = false): Promise<string> {
    if (!force && this.usable()) return this.accessToken
    if (!this.refreshToken) {
      if (!force && this.accessToken) return this.accessToken
      throw DriverError.auth('HalalCloud has no refresh token; connect the storage again from the storage settings.')
    }
    const before = this.accessToken
    return await singleFlightRefresh(
      this.ctx,
      async () => await this.refresh(),
      async () => {
        await this.ctx.reloadCredentials?.()
        const current = this.accessToken
        return current && current !== before ? current : null
      },
    )
  }

  private async refuse(message: string): Promise<never> {
    await this.ctx.markNeedsReauth(message)
    throw DriverError.auth(message)
  }

  private async refresh(): Promise<string> {
    const clientId = this.credential('clientId')
    const clientSecret = this.credential('clientSecret')
    if (!clientId || !clientSecret) {
      return await this.refuse('HalalCloud needs a client id and secret to refresh the token.')
    }
    const previous = { accessToken: this.accessToken, refreshToken: this.refreshToken }
    if (!previous.refreshToken) {
      return await this.refuse('HalalCloud has no refresh token; connect the storage again from the storage settings.')
    }

    const body = {
      refresh_token: previous.refreshToken,
      grant_type: 'refresh_token',
      client_id: clientId,
    }
    const bodyRaw = toUtf8(JSON.stringify(body))
    const sign = await hcloudSign({
      apiHost: this.host,
      secretId: clientId,
      secretKey: clientSecret,
      accessToken: previous.accessToken,
      method: 'POST',
      apiPath: REFRESH_PATH,
      bodyRaw,
    })

    let response: Response
    try {
      response = await fetch(sign.url, {
        method: 'POST',
        headers: sign.headers,
        body: bodyRaw as unknown as BodyInit,
        signal: AbortSignal.timeout(20_000),
      })
    } catch (error) {
      throw await this.refuse(
        `HalalCloud could not be reached: ${error instanceof Error ? error.message : String(error)}`,
      )
    }

    if (response.status === 429) {
      await response.body?.cancel().catch(() => undefined)
      throw DriverError.rateLimited('HalalCloud is rate limiting token requests')
    }
    const text = await response.text().catch(() => '')
    let payload: HCloudTokenResponse
    try {
      payload = JSON.parse(text) as HCloudTokenResponse
    } catch {
      throw await this.refuse('HalalCloud returned a non-JSON token response')
    }
    if (!response.ok || !payload.access_token) {
      const reason = payload.message || payload.msg || `HTTP ${response.status}`
      throw await this.refuse(`HalalCloud refused the refresh token (${reason})`)
    }

    const patch: Record<string, string> = {
      accessToken: payload.access_token,
      expiresAt: payload.expires_in ? String(Date.now() + payload.expires_in * 1000) : '0',
    }
    if (payload.refresh_token && payload.refresh_token !== previous.refreshToken) {
      patch.refreshToken = payload.refresh_token
    }
    const effective = await this.ctx.saveCredentials(patch, { expect: previous })
    Object.assign(this.ctx.credentials, effective)
    return this.accessToken || payload.access_token
  }

  private async withToken<T>(work: (token: string) => Promise<T>): Promise<T> {
    const token = await this.token()
    try {
      return await work(token)
    } catch (error) {
      if (!(error instanceof DriverError) || error.kind !== 'auth') throw error
      this.invalidate()
      try {
        return await work(await this.token(true))
      } catch (retryError) {
        const message = retryError instanceof Error ? retryError.message : 'HalalCloud rejected the token'
        await this.ctx.markNeedsReauth(message)
        throw DriverError.auth(message)
      }
    }
  }

  private async signed<T>(path: string, body: unknown, token: string): Promise<T> {
    const bodyRaw = body === undefined ? new Uint8Array(0) : toUtf8(JSON.stringify(body))
    const sign = await hcloudSign({
      apiHost: this.host,
      secretId: this.credential('clientId'),
      secretKey: this.credential('clientSecret'),
      accessToken: token,
      method: 'POST',
      apiPath: path,
      bodyRaw,
    })
    const response = await this.request(sign.url, {
      method: 'POST',
      headers: sign.headers,
      body: bodyRaw.length > 0 ? bodyRaw as unknown as BodyInit : undefined,
      timeoutMs: 20_000,
    })
    return await response.json() as T
  }

  private async api<T>(path: string, body: unknown): Promise<T> {
    return await this.withToken(async (token) => await this.signed<T>(path, body, token))
  }

  private fullPath(clean: string): string {
    if (this.rootPath === '/') return clean
    return clean === '/' ? this.rootPath : `${this.rootPath}${clean}`
  }

  private async listPage(
    parent: string,
    token: string,
    limit: number,
  ): Promise<{ files: HCloudFile[]; next: string | null }> {
    const payload = await this.api<HCloudFileListResponse>(LIST_PATH, {
      parent: { path: parent },
      list_info: { limit, token },
    })
    const files = payload.files ?? []
    const next = payload.list_info?.token || ''
    return { files, next: files.length > 0 && next ? next : null }
  }

  private async pageAt(parent: string, pageNumber: number, pageSize: number): Promise<{ files: HCloudFile[]; next: string | null }> {
    let token = ''
    for (let current = 1; current <= MAX_LIST_PAGES; current++) {
      const result = await this.listPage(parent, token, pageSize)
      if (current === pageNumber) return result
      if (result.next === null) break
      token = result.next
    }
    return { files: [], next: null }
  }

  private async listAll(parent: string): Promise<HCloudFile[]> {
    const collected = await collectPages(async ({ cursor }) => {
      const result = await this.listPage(parent, cursor ?? '', PAGE_SIZE)
      return { items: result.files, next: result.next }
    }, { mode: 'cursor', maxPages: MAX_LIST_PAGES })
    return collected.items
  }

  async list(path: string, options: DriverListOptions = {}): Promise<DriverListResult> {
    const clean = driverPath(path)
    const parent = this.fullPath(clean)
    const pageSize = Math.max(1, options.pageSize ?? PAGE_SIZE)
    const needle = options.search?.toLowerCase()
    if (options.page !== undefined) {
      const result = await this.pageAt(parent, Math.max(1, options.page), pageSize)
      let entries = result.files.map(fileEntry)
      if (needle) entries = entries.filter((entry) => entry.name.toLowerCase().includes(needle))
      return { entries, cursor: result.next, truncated: result.next !== null }
    }
    const collected = await collectPages(async ({ cursor }) => {
      const result = await this.listPage(parent, cursor ?? '', pageSize)
      return { items: result.files, next: result.next }
    }, { mode: 'cursor', maxPages: MAX_LIST_PAGES })
    let entries = collected.items.map(fileEntry)
    if (needle) entries = entries.filter((entry) => entry.name.toLowerCase().includes(needle))
    return { entries, cursor: null, truncated: collected.truncated }
  }

  private async resolve(clean: string): Promise<HCloudFile> {
    if (clean === '/') return { name: 'root', path: this.rootPath, dir: true, size: 0 }
    const full = this.fullPath(clean)
    const parent = driverParentPath(full)
    const name = driverFileName(full)
    const files = await this.listAll(parent)
    const found = files.find((file) => file.name === name || file.path === full)
    if (!found) throw DriverError.notFound(`HalalCloud could not resolve ${clean}`)
    return found
  }

  async stat(path: string): Promise<DriverEntry> {
    const clean = driverPath(path)
    const file = await this.resolve(clean)
    if (clean === '/') return { name: 'root', kind: 'folder', size: 0, modifiedAt: 0, ref: file.path }
    return fileEntry(file)
  }

  private async downloadAddress(file: HCloudFile): Promise<string> {
    const path = file.path || ''
    if (!path) throw DriverError.notFound('HalalCloud did not return the file path')
    const payload = await this.api<HCloudDownloadAddressResponse>(DOWNLOAD_ADDRESS_PATH, {
      path,
      identity: file.identity || '',
    })
    if (!payload.download_address) throw DriverError.upstream('HalalCloud returned no download address')
    return payload.download_address
  }

  async read(path: string, range?: string | null): Promise<Response> {
    const clean = driverPath(path)
    const file = await this.resolve(clean)
    if (file.dir === true) throw DriverError.unsupported('A folder cannot be read as a file')
    const address = await this.downloadAddress(file)
    return await this.request(address, {
      headers: range ? { Range: range } : {},
      redirect: 'follow',
      timeoutMs: 30_000,
      retries: 0,
    })
  }

  async directLink(path: string): Promise<string | null> {
    const clean = driverPath(path)
    const file = await this.resolve(clean)
    if (file.dir === true) return null
    return await this.downloadAddress(file)
  }

  async upload(_path: string, _body: Uint8Array | ReadableStream, _options: DriverUploadOptions): Promise<void> {
    throw DriverError.unsupported('HalalCloud direct upload is not supported: the reference client has no stateless upload path')
  }

  async mkdir(path: string): Promise<void> {
    const clean = driverPath(path)
    if (clean === '/') return
    const full = this.fullPath(clean)
    const parent = driverParentPath(full)
    const name = driverFileName(full)
    await this.api(CREATE_PATH, { parent, path: full, name, dir: true })
  }

  async rename(path: string, newName: string): Promise<void> {
    const clean = driverPath(path)
    if (clean === '/') throw DriverError.invalid('The root cannot be renamed')
    const full = this.fullPath(clean)
    await this.api(RENAME_PATH, { path: full, name: newName })
  }

  async move(fromPath: string, toPath: string): Promise<void> {
    const from = driverPath(fromPath)
    const to = driverPath(toPath)
    if (from === '/' || to === '/') throw DriverError.invalid('The root cannot be moved')
    const entry = await this.resolve(from)
    await this.api(MOVE_PATH, {
      source: [{ path: entry.path || this.fullPath(from), identity: entry.identity || '' }],
      dest: { path: this.fullPath(to) },
    })
  }

  async copy(fromPath: string, toPath: string): Promise<void> {
    const from = driverPath(fromPath)
    const to = driverPath(toPath)
    if (from === '/' || to === '/') throw DriverError.invalid('The root cannot be copied')
    const entry = await this.resolve(from)
    await this.api(COPY_PATH, {
      source: [{ path: entry.path || this.fullPath(from), identity: entry.identity || '' }],
      dest: { path: this.fullPath(to) },
    })
  }

  async remove(path: string): Promise<void> {
    const clean = driverPath(path)
    if (clean === '/') throw DriverError.invalid('The root cannot be removed')
    const entry = await this.resolve(clean)
    await this.api(DELETE_PATH, {
      source: [{
        path: entry.path || this.fullPath(clean),
        identity: entry.identity || '',
        dir: entry.dir === true,
      }],
    })
  }

  async test(): Promise<{ ok: boolean; message: string }> {
    try {
      await this.authenticate(false)
      await this.list('/', { page: 1, pageSize: 1 })
      return { ok: true, message: 'HalalCloud is reachable' }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : 'HalalCloud is unavailable' }
    }
  }
}

export function createHalalCloudOpenDriver(ctx: DriverContext): MountDriver {
  return new HalalCloudOpenDriver(ctx)
}
