/**
 * Degoo driver.
 *
 * Degoo authenticates with a username/password that yields a JWT plus a refresh token, then serves
 * everything through the AppSync GraphQL endpoint. Paths are resolved by walking directory ids, and
 * a file's download address comes from the `getOverlay4` query. Mutations create folders, rename,
 * move and delete entries; uploads and copies stay unsupported.
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

const LOGIN_URL = 'https://rest-api.degoo.com/login'
const ACCESS_TOKEN_URL = 'https://rest-api.degoo.com/access-token/v2'
const GRAPHQL_URL = 'https://production-appsync.degoo.com/graphql'
const API_KEY = 'da2-vs6twz5vnjdavpqndtbzg3prra'
const PAGE_LIMIT = 1000
const MAX_LIST_PAGES = 50
const REFRESH_LEAD_MS = 5 * 60 * 1000

const LIST_QUERY = `query GetFileChildren5($Token: String! $ParentID: String $AllParentIDs: [String] $Limit: Int! $Order: Int! $NextToken: String ) { getFileChildren5(Token: $Token ParentID: $ParentID AllParentIDs: $AllParentIDs Limit: $Limit Order: $Order NextToken: $NextToken) { Items { ID ParentID Name Category Size CreationTime LastModificationTime LastUploadTime FilePath IsInRecycleBin DeviceID MetadataID } NextToken } }`
const ROOT_QUERY = `query GetFileChildren5($Token: String! $ParentID: String $AllParentIDs: [String] $Limit: Int! $Order: Int! $NextToken: String ) { getFileChildren5(Token: $Token ParentID: $ParentID AllParentIDs: $AllParentIDs Limit: $Limit Order: $Order NextToken: $NextToken) { Items { ParentID } NextToken } }`
const OVERLAY_QUERY = `query GetOverlay4($Token: String!, $ID: IDType!) { getOverlay4(Token: $Token, ID: $ID) { ID ParentID Name Category Size CreationTime LastModificationTime LastUploadTime URL FilePath IsInRecycleBin DeviceID MetadataID } }`
const MKDIR_MUTATION = `mutation SetUploadFile3($Token: String!, $FileInfos: [FileInfoUpload3]!) { setUploadFile3(Token: $Token, FileInfos: $FileInfos) }`
const RENAME_MUTATION = `mutation SetRenameFile($Token: String!, $FileRenames: [FileRenameInfo]!) { setRenameFile(Token: $Token, FileRenames: $FileRenames) }`
const MOVE_MUTATION = `mutation SetMoveFile($Token: String!, $Copy: Boolean, $NewParentID: String!, $FileIDs: [String]!) { setMoveFile(Token: $Token, Copy: $Copy, NewParentID: $NewParentID, FileIDs: $FileIDs) }`
const DELETE_MUTATION = `mutation SetDeleteFile5($Token: String!, $IsInRecycleBin: Boolean!, $IDs: [IDType]!) { setDeleteFile5(Token: $Token, IsInRecycleBin: $IsInRecycleBin, IDs: $IDs) }`
const FOLDER_CHECKSUM = 'CgAQAg'

interface DegooItem {
  ID: string
  ParentID?: string
  Name: string
  Category?: number
  Size?: string | number
  URL?: string
  LastModificationTime?: string
}

interface DegooGraphql<T> {
  data?: T
  errors?: Array<{ errorType?: string; message?: string }>
}

interface DegooChildren {
  getFileChildren5?: { Items?: DegooItem[]; NextToken?: string }
}

interface DegooOverlay {
  getOverlay4?: DegooItem
}

function isFolder(category: number | undefined): boolean {
  return category === 1 || category === 2 || category === 10
}

function modifiedAt(item: DegooItem): number {
  const raw = item.LastModificationTime
  if (!raw) return 0
  const numeric = Number(raw)
  if (Number.isFinite(numeric) && numeric > 0) return numeric < 1e12 ? numeric * 1000 : numeric
  return Date.parse(raw) || 0
}

function fileEntry(item: DegooItem): DriverEntry {
  const folder = isFolder(item.Category)
  return {
    name: item.Name,
    kind: folder ? 'folder' : 'file',
    size: folder ? 0 : Number(item.Size) || 0,
    modifiedAt: modifiedAt(item),
    ref: item.ID,
    mime: folder ? 'application/octet-stream' : driverEntryMime(item.Name),
  }
}

function jwtExpiry(token: string): number {
  const parts = token.split('.')
  if (parts.length !== 3) return 0
  try {
    const parsed = JSON.parse(atob(parts[1]!.replace(/-/g, '+').replace(/_/g, '/'))) as { exp?: number }
    return Number(parsed.exp) > 0 ? Number(parsed.exp) * 1000 : 0
  } catch {
    return 0
  }
}

function downloadError(response: Response): DriverError {
  if (response.status === 429) {
    const retry = Number(response.headers.get('retry-after'))
    return DriverError.rateLimited('Degoo is rate limiting the download', Number.isFinite(retry) ? retry * 1000 : undefined)
  }
  if (response.status === 404) return DriverError.notFound('Degoo could not find the download')
  if (response.status === 401 || response.status === 403) return DriverError.auth('Degoo refused the download')
  return DriverError.upstream(`Degoo download failed (HTTP ${response.status})`)
}

export class DegooDriver extends HttpDriverBase implements MountDriver {
  readonly definition = findCloudDriveDriver('degoo')!
  readonly capabilities = this.definition.capabilities
  private accessToken = ''
  private refreshToken = ''
  private rootId = ''
  private readonly pathIds = new Map<string, string>()

  constructor(ctx: DriverContext) {
    super(ctx)
    this.accessToken = String(ctx.credentials.accessToken ?? '')
    this.refreshToken = String(ctx.credentials.refreshToken ?? '')
  }

  protected async login(force: boolean): Promise<void> {
    this.accessToken = String(this.ctx.credentials.accessToken ?? '')
    this.refreshToken = String(this.ctx.credentials.refreshToken ?? '')
    if (!force && this.accessToken && this.tokenUsable()) return
    try {
      await this.ensureToken()
    } catch (error) {
      if (error instanceof DriverError && error.kind === 'auth') {
        await this.ctx.markNeedsReauth(error.message).catch(() => undefined)
      }
      throw error
    }
  }

  private tokenUsable(): boolean {
    if (!this.accessToken) return false
    const stored = Number(this.ctx.credentials.expiresAt) || 0
    if (stored) return stored - Date.now() > REFRESH_LEAD_MS
    const expiry = jwtExpiry(this.accessToken)
    if (!expiry) return false
    return expiry - Date.now() > REFRESH_LEAD_MS
  }

  private async ensureToken(): Promise<void> {
    const before = { accessToken: this.accessToken, refreshToken: this.refreshToken }
    const token = await singleFlightRefresh(
      this.ctx,
      async () => before.refreshToken ? await this.refreshAccess(before) : await this.passwordLogin(before),
      async () => {
        await this.ctx.reloadCredentials?.()
        const currentAccess = String(this.ctx.credentials.accessToken ?? '')
        const currentRefresh = String(this.ctx.credentials.refreshToken ?? '')
        if (currentRefresh && currentRefresh !== before.refreshToken) {
          this.accessToken = currentAccess
          this.refreshToken = currentRefresh
          return currentAccess || null
        }
        if (currentAccess && currentAccess !== before.accessToken) {
          this.accessToken = currentAccess
          return currentAccess
        }
        return null
      },
    )
    this.accessToken = token
  }

  private async refreshAccess(before: Record<string, string>): Promise<string> {
    const response = await this.request(ACCESS_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ RefreshToken: before.refreshToken }),
    })
    const payload = await response.json().catch(() => null) as { AccessToken?: string; RefreshToken?: string } | null
    if (!payload?.AccessToken) throw DriverError.auth('Degoo refresh returned no access token')
    const expiry = jwtExpiry(payload.AccessToken) || Date.now() + 3600_000
    const effective = await this.saveCredential({
      accessToken: payload.AccessToken,
      refreshToken: payload.RefreshToken || before.refreshToken,
      expiresAt: String(expiry),
    }, before)
    this.accessToken = String(effective.accessToken ?? payload.AccessToken)
    this.refreshToken = String(effective.refreshToken ?? before.refreshToken)
    return this.accessToken
  }

  private async passwordLogin(before: Record<string, string>): Promise<string> {
    const username = this.configText('username')
    const password = String(this.ctx.credentials.password ?? '')
    if (!username || !password) throw DriverError.auth('Degoo needs a username and password, or a refresh token.')
    const response = await this.request(LOGIN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://app.degoo.com' },
      body: JSON.stringify({ GenerateToken: true, Username: username, Password: password }),
    })
    const payload = await response.json().catch(() => null) as { Token?: string; RefreshToken?: string } | null
    if (!payload) throw DriverError.auth('Degoo login returned an unexpected body')
    let accessToken = payload.Token ?? ''
    const refreshToken = payload.RefreshToken ?? ''
    if (!accessToken && refreshToken) {
      const tokenResponse = await this.request(ACCESS_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ RefreshToken: refreshToken }),
      })
      const tokenPayload = await tokenResponse.json().catch(() => null) as { AccessToken?: string } | null
      accessToken = tokenPayload?.AccessToken ?? ''
    }
    if (!accessToken) throw DriverError.auth('Degoo login returned no access token')
    const effective = await this.saveCredential({
      accessToken,
      refreshToken,
      expiresAt: String(jwtExpiry(accessToken) || Date.now() + 3600_000),
    }, before)
    this.accessToken = String(effective.accessToken ?? accessToken)
    this.refreshToken = String(effective.refreshToken ?? refreshToken)
    return this.accessToken
  }

  private async graphql<T>(operationName: string, query: string, variables: Record<string, unknown>): Promise<T> {
    return await this.withAuth(async () => {
      const response = await this.request(GRAPHQL_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': API_KEY,
          Authorization: `Bearer ${this.accessToken}`,
        },
        body: JSON.stringify({ operationName, query, variables: { ...variables, Token: this.accessToken } }),
      })
      const payload = await response.json().catch(() => null) as DegooGraphql<T> | null
      if (!payload) throw DriverError.upstream('Degoo returned an unexpected body')
      const error = payload.errors?.[0]
      if (error) {
        const text = `${error.errorType ?? ''} ${error.message ?? ''}`.trim()
        if (/unauthor|not authorized|invalid token|token expired/i.test(text)) {
          throw DriverError.auth(`Degoo authorization expired: ${text}`)
        }
        if (/not found|notfound/i.test(text)) throw DriverError.notFound(`Degoo could not find the item: ${text}`)
        throw DriverError.upstream(`Degoo GraphQL error: ${text}`)
      }
      if (payload.data === undefined) throw DriverError.upstream('Degoo returned no data')
      return payload.data
    })
  }

  private async rootFolderId(): Promise<string> {
    const configured = this.configText('rootFolderId').trim()
    if (configured) return configured
    if (this.rootId) return this.rootId
    const data = await this.graphql<DegooChildren>('GetFileChildren5', ROOT_QUERY, {
      ParentID: '0',
      Limit: 10,
      Order: 3,
    })
    this.rootId = data.getFileChildren5?.Items?.[0]?.ParentID || '0'
    return this.rootId
  }

  private async childrenPage(parentId: string, pageNumber: number, pageSize: number): Promise<{ items: DegooItem[]; next: string | null }> {
    let next = ''
    for (let current = 1; current <= Math.max(1, pageNumber); current++) {
      const variables: Record<string, unknown> = { ParentID: parentId, Limit: Math.max(1, pageSize), Order: 3 }
      if (next) variables.NextToken = next
      const data = await this.graphql<DegooChildren>('GetFileChildren5', LIST_QUERY, variables)
      const items = data.getFileChildren5?.Items ?? []
      if (current === pageNumber) return { items, next: data.getFileChildren5?.NextToken || null }
      const token = data.getFileChildren5?.NextToken ?? ''
      if (!token || token === next || items.length === 0) break
      next = token
    }
    return { items: [], next: null }
  }

  private async childrenAll(parentId: string): Promise<DegooItem[]> {
    const items: DegooItem[] = []
    let next = ''
    for (let page = 0; page < MAX_LIST_PAGES; page++) {
      const variables: Record<string, unknown> = { ParentID: parentId, Limit: PAGE_LIMIT, Order: 3 }
      if (next) variables.NextToken = next
      const data = await this.graphql<DegooChildren>('GetFileChildren5', LIST_QUERY, variables)
      items.push(...(data.getFileChildren5?.Items ?? []))
      const token = data.getFileChildren5?.NextToken ?? ''
      if (!token || token === next) return items
      next = token
    }
    return items
  }

  private async resolveFolder(path: string): Promise<string> {
    const clean = driverPath(path)
    const root = await this.rootFolderId()
    if (clean === '/') return root
    let current = root
    let prefix = ''
    for (const segment of clean.split('/').filter(Boolean)) {
      prefix = `${prefix}/${segment}`
      const cached = this.pathIds.get(prefix)
      if (cached) {
        current = cached
        continue
      }
      const items = await this.childrenAll(current)
      const found = items.find((item) => isFolder(item.Category) && item.Name === segment)
      if (!found) throw DriverError.notFound(`Degoo could not find the folder ${prefix}`)
      current = found.ID
      this.pathIds.set(prefix, current)
    }
    return current
  }

  private async resolveEntry(path: string): Promise<DegooItem> {
    const clean = driverPath(path)
    if (clean === '/') throw DriverError.notFound('The root is not a file')
    const parentId = await this.resolveFolder(driverParentPath(clean))
    const items = await this.childrenAll(parentId)
    const found = items.find((item) => item.Name === driverFileName(clean))
    if (!found) throw DriverError.notFound(`Degoo could not find ${clean}`)
    return found
  }

  async list(path: string, options: DriverListOptions = {}): Promise<DriverListResult> {
    const clean = driverPath(path)
    const parentId = await this.resolveFolder(clean)
    const pageSize = Math.min(PAGE_LIMIT, Math.max(1, options.pageSize ?? PAGE_LIMIT))
    if (options.page !== undefined) {
      const page = await this.childrenPage(parentId, Math.max(1, options.page), pageSize)
      return { entries: page.items.map(fileEntry), cursor: page.next, truncated: page.next !== null }
    }
    const collected = await collectPages(async ({ cursor }) => {
      const variables: Record<string, unknown> = { ParentID: parentId, Limit: pageSize, Order: 3 }
      if (cursor) variables.NextToken = cursor
      const data = await this.graphql<DegooChildren>('GetFileChildren5', LIST_QUERY, variables)
      return { items: data.getFileChildren5?.Items ?? [], next: data.getFileChildren5?.NextToken || null }
    }, { mode: 'cursor', maxPages: MAX_LIST_PAGES })
    return { entries: collected.items.map(fileEntry), cursor: null, truncated: collected.truncated }
  }

  async stat(path: string): Promise<DriverEntry> {
    const clean = driverPath(path)
    if (clean === '/') {
      return { name: 'root', kind: 'folder', size: 0, modifiedAt: Date.now(), ref: await this.rootFolderId() }
    }
    return fileEntry(await this.resolveEntry(clean))
  }

  private async overlayUrl(item: DegooItem): Promise<string> {
    const data = await this.graphql<DegooOverlay>('GetOverlay4', OVERLAY_QUERY, { ID: { FileID: item.ID } })
    const url = data.getOverlay4?.URL ?? ''
    if (!url) throw DriverError.notFound('Degoo returned no download address')
    return url
  }

  async directLink(path: string): Promise<string | null> {
    const entry = await this.stat(path)
    if (entry.kind === 'folder') return null
    return await this.overlayUrl(await this.resolveEntry(driverPath(path)))
  }

  async read(path: string, range?: string | null): Promise<Response> {
    const clean = driverPath(path)
    const entry = await this.stat(clean)
    if (entry.kind === 'folder') throw DriverError.unsupported('A folder cannot be read as a file')
    const url = await this.overlayUrl(await this.resolveEntry(clean))
    const response = await fetch(url, {
      headers: range ? { Range: range } : {},
      redirect: 'follow',
      signal: AbortSignal.timeout(30_000),
    })
    if (!response.ok && response.status !== 206) {
      await response.body?.cancel().catch(() => undefined)
      throw downloadError(response)
    }
    return response
  }

  async upload(path: string, _body: Uint8Array | ReadableStream, _options: DriverUploadOptions): Promise<void> {
    driverPath(path)
    throw DriverError.unsupported('Degoo upload is not supported in a stateless environment')
  }

  async mkdir(path: string): Promise<void> {
    const clean = driverPath(path)
    if (clean === '/') return
    const parentId = await this.resolveFolder(driverParentPath(clean))
    await this.graphql<unknown>('SetUploadFile3', MKDIR_MUTATION, {
      FileInfos: [
        {
          Checksum: FOLDER_CHECKSUM,
          Name: driverFileName(clean),
          CreationTime: Date.now(),
          ParentID: parentId,
          Size: 0,
        },
      ],
    })
    this.pathIds.clear()
  }

  async rename(path: string, newName: string): Promise<void> {
    const entry = await this.resolveEntry(driverPath(path))
    await this.graphql<unknown>('SetRenameFile', RENAME_MUTATION, {
      FileRenames: [{ ID: entry.ID, NewName: newName }],
    })
    this.pathIds.clear()
  }

  async move(fromPath: string, toPath: string): Promise<void> {
    const from = driverPath(fromPath)
    const to = driverPath(toPath)
    const entry = await this.resolveEntry(from)
    const parentId = await this.resolveFolder(driverParentPath(to))
    await this.graphql<unknown>('SetMoveFile', MOVE_MUTATION, {
      Copy: false,
      NewParentID: parentId,
      FileIDs: [entry.ID],
    })
    this.pathIds.clear()
  }

  async remove(path: string): Promise<void> {
    const entry = await this.resolveEntry(driverPath(path))
    await this.graphql<unknown>('SetDeleteFile5', DELETE_MUTATION, {
      IsInRecycleBin: false,
      IDs: [{ FileID: entry.ID }],
    })
    this.pathIds.clear()
  }

  async copy(fromPath: string, toPath: string): Promise<void> {
    driverPath(fromPath)
    driverPath(toPath)
    throw DriverError.unsupported('Degoo copy is not supported')
  }

  async test(): Promise<{ ok: boolean; message: string }> {
    try {
      await this.authenticate(false)
      const data = await this.graphql<DegooChildren>('GetFileChildren5', LIST_QUERY, {
        ParentID: await this.rootFolderId(),
        Limit: 1,
        Order: 3,
      })
      const count = data.getFileChildren5?.Items?.length ?? 0
      return { ok: true, message: `Degoo is reachable · ${count} item(s)` }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : 'Degoo is unavailable' }
    }
  }
}

export function createDegooDriver(ctx: DriverContext): MountDriver {
  return new DegooDriver(ctx)
}
