/**
 * Teambition (project collections/works) driver, cookie authenticated.
 *
 * Ported from `OpenList-Worker/src/backend/drivers/teambition`: folders are `/api/collections`
 * and files are `/api/works`, both paged with `_parentId`/`_projectId`; download URLs come from the
 * work row and are resolved through their 302 before streaming. The upstream offers no upload
 * endpoint, so `upload` stays unsupported instead of pretending otherwise.
 */
import { findCloudDriveDriver } from '@shared/clouddrive/drivers'
import { cloudDriveNameProblem } from '@shared/clouddrive/model'
import {
  DriverError,
  driverEntryMime,
  type DriverContext,
  type DriverEntry,
  type DriverListOptions,
  type DriverListResult,
  type MountDriver,
} from './contract'
import {
  HttpDriverBase,
  collectPages,
  driverFileName,
  driverParentPath,
  driverPath,
} from './http'

const PAGE_SIZE = 50
const MAX_PAGES = 50

interface TbCollection {
  _id: string
  title: string
  updated?: string
}

interface TbWork {
  _id: string
  fileName: string
  fileSize?: number
  downloadUrl?: string
  thumbnail?: string
  thumbnailUrl?: string
  updated?: string
}

interface TbError {
  name?: string
  message?: string
}

function isAuthMessage(message: string): boolean {
  return /unauthor|forbidden|auth|login|not.?log.?in|token|\u767b\u5f55|\u672a\u6388\u6743|\u6743\u9650|\u8fc7\u671f/i.test(message)
}

function payloadError(payload: TbError): DriverError {
  const message = payload.message || payload.name || 'Teambition rejected the request'
  if (isAuthMessage(message)) return DriverError.auth(`Teambition refused the cookie: ${message}`)
  if (/not.?found|\u4e0d\u5b58\u5728/i.test(message)) return DriverError.notFound(message)
  if (/rate|too.?many|\u9891\u7e41/i.test(message)) return DriverError.rateLimited(message)
  return DriverError.upstream(message)
}

function throwDownloadStatus(status: number): never {
  if (status === 401 || status === 403) throw DriverError.auth(`The download was refused (HTTP ${status})`)
  if (status === 404) throw DriverError.notFound('The download address was not found (HTTP 404)')
  if (status === 429) throw DriverError.rateLimited('The download was rate limited')
  throw DriverError.upstream(`The download answered HTTP ${status}`)
}

function collectionEntry(collection: TbCollection): DriverEntry {
  return {
    name: collection.title,
    kind: 'folder',
    size: 0,
    modifiedAt: Date.parse(collection.updated ?? '') || 0,
    ref: collection._id,
    mime: 'application/octet-stream',
  }
}

function workEntry(work: TbWork): DriverEntry {
  return {
    name: work.fileName,
    kind: 'file',
    size: Number(work.fileSize) || 0,
    modifiedAt: Date.parse(work.updated ?? '') || 0,
    ref: work._id,
    mime: driverEntryMime(work.fileName),
  }
}

class TeambitionDriver extends HttpDriverBase implements MountDriver {
  readonly definition = findCloudDriveDriver('teambition')!
  readonly capabilities = this.definition.capabilities
  private cookie = ''
  private readonly pathIds = new Map<string, string>()

  private baseUrl(): string {
    return this.configText('region', 'china') === 'international'
      ? 'https://us.teambition.com'
      : 'https://www.teambition.com'
  }

  private projectId(): string {
    return this.configText('projectId').trim()
  }

  protected async login(force: boolean): Promise<void> {
    if (!force && this.cookie) return
    const raw = (this.ctx.credentials.cookie ?? '').trim()
    if (!raw) throw DriverError.auth('Teambition needs a browser cookie')
    if (!this.projectId()) throw DriverError.invalid('Teambition needs a project id')
    this.cookie = raw
  }

  private async api<T>(
    pathname: string,
    method: 'GET' | 'POST' | 'PUT' | 'DELETE' = 'GET',
    body?: Record<string, unknown>,
    query?: Record<string, string>,
  ): Promise<T> {
    const qs = query ? `?${new URLSearchParams(query).toString()}` : ''
    return await this.withAuth(async () => {
      const response = await this.request(`${this.baseUrl()}${pathname}${qs}`, {
        method,
        headers: {
          Cookie: this.cookie,
          Accept: 'application/json',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        timeoutMs: 30_000,
      })
      if (response.status === 201 || response.status === 204) return {} as T
      const text = await response.text()
      let payload: unknown
      try {
        payload = text ? JSON.parse(text) : {}
      } catch {
        throw DriverError.upstream('Teambition returned an unexpected body')
      }
      const error = payload as TbError
      if (error && !Array.isArray(payload) && (typeof error.name === 'string' || typeof error.message === 'string')) {
        throw payloadError(error)
      }
      return payload as T
    })
  }

  private baseQuery(parentId: string, page: number, size: number): Record<string, string> {
    return {
      _parentId: parentId,
      _projectId: this.projectId(),
      order: 'fileNameAsc',
      count: String(size),
      page: String(page),
    }
  }

  private async collectionsPage(parentId: string, page: number, size: number): Promise<TbCollection[]> {
    const list = await this.api<TbCollection[]>('/api/collections', 'GET', undefined, this.baseQuery(parentId, page, size))
    return (Array.isArray(list) ? list : []).filter((collection) => Boolean(collection.title))
  }

  private async worksPage(parentId: string, page: number, size: number): Promise<TbWork[]> {
    const list = await this.api<TbWork[]>('/api/works', 'GET', undefined, this.baseQuery(parentId, page, size))
    return Array.isArray(list) ? list : []
  }

  private async allCollections(parentId: string): Promise<TbCollection[]> {
    const collected = await collectPages(async ({ page }) => {
      const items = await this.collectionsPage(parentId, page, PAGE_SIZE)
      return { items, next: items.length >= PAGE_SIZE ? String(page + 1) : null }
    }, { maxPages: MAX_PAGES })
    return collected.items
  }

  private async allWorks(parentId: string): Promise<TbWork[]> {
    const collected = await collectPages(async ({ page }) => {
      const items = await this.worksPage(parentId, page, PAGE_SIZE)
      return { items, next: items.length >= PAGE_SIZE ? String(page + 1) : null }
    }, { maxPages: MAX_PAGES })
    return collected.items
  }

  private async resolveId(path: string): Promise<string> {
    const clean = driverPath(path)
    if (clean === '/') return ''
    const cached = this.pathIds.get(clean)
    if (cached) return cached
    let current = ''
    let prefix = ''
    for (const segment of clean.split('/').filter(Boolean)) {
      const collections = await this.allCollections(current)
      const hit = collections.find((collection) => collection.title === segment)
      if (!hit) throw DriverError.notFound(`Folder not found: ${segment}`)
      current = hit._id
      prefix = `${prefix}/${segment}`
      this.pathIds.set(prefix, current)
    }
    return current
  }

  private async resolveEntry(path: string): Promise<{ isDir: boolean; id: string; name: string; parentId: string; updated?: string; work?: TbWork }> {
    const clean = driverPath(path)
    if (clean === '/') throw DriverError.notFound('The root is not a file')
    const name = driverFileName(clean)
    const parentId = await this.resolveId(driverParentPath(clean))
    const collection = (await this.allCollections(parentId)).find((item) => item.title === name)
    if (collection) return { isDir: true, id: collection._id, name, parentId, updated: collection.updated }
    const work = (await this.allWorks(parentId)).find((item) => item.fileName === name)
    if (!work) throw DriverError.notFound(`Not found: ${name}`)
    return { isDir: false, id: work._id, name, parentId, work }
  }

  async list(path: string, options: DriverListOptions = {}): Promise<DriverListResult> {
    const parentId = await this.resolveId(path)
    const pageSize = Math.max(1, options.pageSize ?? PAGE_SIZE)
    if (options.page !== undefined) {
      const page = Math.max(1, options.page)
      const folders = await this.collectionsPage(parentId, page, pageSize)
      const works = await this.worksPage(parentId, page, pageSize)
      const more = folders.length >= pageSize || works.length >= pageSize
      return {
        entries: [...folders.map(collectionEntry), ...works.map(workEntry)],
        cursor: more ? String(page + 1) : null,
        truncated: more,
      }
    }
    const folders = await this.allCollections(parentId)
    const works = await this.allWorks(parentId)
    return {
      entries: [...folders.map(collectionEntry), ...works.map(workEntry)],
      cursor: null,
      truncated: false,
    }
  }

  async stat(path: string): Promise<DriverEntry> {
    const clean = driverPath(path)
    if (clean === '/') {
      return { name: '/', kind: 'folder', size: 0, modifiedAt: Date.now(), ref: '', mime: 'application/octet-stream' }
    }
    const entry = await this.resolveEntry(clean)
    return entry.isDir || !entry.work
      ? {
          name: entry.name,
          kind: 'folder',
          size: 0,
          modifiedAt: Date.parse(entry.updated ?? '') || 0,
          ref: entry.id,
          mime: 'application/octet-stream',
        }
      : workEntry(entry.work)
  }

  private async downloadLink(work: TbWork): Promise<string> {
    const url = work.downloadUrl ?? ''
    if (!url) throw DriverError.upstream('Teambition returned no download address')
    const response = await fetch(url, {
      method: 'GET',
      redirect: 'manual',
      headers: { Cookie: this.cookie },
      signal: AbortSignal.timeout(30_000),
    })
    const location = response.headers.get('location')
    await response.body?.cancel().catch(() => undefined)
    if (response.status >= 300 && response.status < 400 && location) return location
    if (!response.ok && response.status !== 206) throwDownloadStatus(response.status)
    return url
  }

  async read(path: string, range?: string | null): Promise<Response> {
    const entry = await this.resolveEntry(path)
    if (entry.isDir || !entry.work) throw DriverError.unsupported('A folder cannot be read as a file')
    const link = await this.downloadLink(entry.work)
    const response = await fetch(link, {
      method: 'GET',
      redirect: 'follow',
      headers: {
        ...(range ? { Range: range } : {}),
        ...(link.startsWith(this.baseUrl()) ? { Cookie: this.cookie } : {}),
      },
      signal: AbortSignal.timeout(30_000),
    })
    if (!response.ok && response.status !== 206) {
      await response.body?.cancel().catch(() => undefined)
      throwDownloadStatus(response.status)
    }
    return response
  }

  async directLink(path: string): Promise<string | null> {
    const entry = await this.resolveEntry(path)
    if (entry.isDir || !entry.work) return null
    return await this.downloadLink(entry.work)
  }

  async upload(path: string): Promise<void> {
    driverPath(path)
    throw DriverError.unsupported('Teambition does not expose an upload endpoint')
  }

  async mkdir(path: string): Promise<void> {
    const clean = driverPath(path)
    if (clean === '/') return
    const parentId = await this.resolveId(driverParentPath(clean))
    await this.api('/api/collections', 'POST', {
      objectType: 'collection',
      _projectId: this.projectId(),
      _creatorId: '',
      created: '',
      updated: '',
      title: driverFileName(clean),
      color: 'blue',
      description: '',
      workCount: 0,
      collectionType: '',
      recentWorks: [],
      _parentId: parentId,
      subCount: null,
    })
    this.pathIds.clear()
  }

  async rename(path: string, newName: string): Promise<void> {
    const problem = cloudDriveNameProblem(newName)
    if (problem) throw DriverError.invalid(problem)
    const entry = await this.resolveEntry(path)
    const prefix = entry.isDir ? '/api/collections/' : '/api/works/'
    await this.api(`${prefix}${encodeURIComponent(entry.id)}`, 'PUT', entry.isDir
      ? { title: newName }
      : { fileName: newName })
    this.pathIds.clear()
  }

  async move(fromPath: string, toPath: string): Promise<void> {
    const source = driverPath(fromPath)
    const target = driverPath(toPath)
    const entry = await this.resolveEntry(source)
    const targetName = driverFileName(target)
    if (targetName !== entry.name) await this.rename(source, targetName)
    const targetParentId = await this.resolveId(driverParentPath(target))
    const prefix = entry.isDir ? '/api/collections/' : '/api/works/'
    await this.api(`${prefix}${encodeURIComponent(entry.id)}/move`, 'PUT', { _parentId: targetParentId })
    this.pathIds.clear()
  }

  async copy(fromPath: string, toPath: string): Promise<void> {
    const source = driverPath(fromPath)
    const target = driverPath(toPath)
    const entry = await this.resolveEntry(source)
    const targetParentId = await this.resolveId(driverParentPath(target))
    const prefix = entry.isDir ? '/api/collections/' : '/api/works/'
    await this.api(`${prefix}${encodeURIComponent(entry.id)}/fork`, 'PUT', { _parentId: targetParentId })
    this.pathIds.clear()
  }

  async remove(path: string): Promise<void> {
    const entry = await this.resolveEntry(path)
    const prefix = entry.isDir ? '/api/collections/' : '/api/works/'
    await this.api(`${prefix}${encodeURIComponent(entry.id)}/archive`, 'POST')
    this.pathIds.clear()
  }

  async test(): Promise<{ ok: boolean; message: string }> {
    try {
      await this.api('/api/v2/roles')
      return { ok: true, message: 'Teambition is reachable' }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : 'Teambition is unavailable' }
    }
  }
}

export function createTeambitionDriver(ctx: DriverContext): MountDriver {
  return new TeambitionDriver(ctx)
}
