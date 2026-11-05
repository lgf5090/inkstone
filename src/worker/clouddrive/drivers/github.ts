/**
 * GitHub repository driver.
 *
 * Reads use the Contents API: it lists one directory at a time, reads a file with
 * `Accept: application/vnd.github.raw`, and returns a short-lived `download_url`. Writes that only
 * touch one path (upload) keep using the Contents API, while operations that need a tree rewrite
 * (mkdir/remove/rename/move/copy) use the Git Data API: blob/tree objects are created without
 * touching the branch, one commit ties them together, and the branch ref is moved once. Every
 * write is serialized per driver and re-reads the branch head when GitHub answers a stale base with
 * 409/422, so two concurrent operations cannot overwrite each other's ref update.
 */
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
} from './contract'
import { HttpDriverBase, driverFileName, driverPath, type HttpOptions } from './http'

const API = 'https://api.github.com'
const JSON_ACCEPT = 'application/vnd.github+json'
const RAW_ACCEPT = 'application/vnd.github.raw'
const PAGE_SIZE = 100

interface GitHubContent {
  name: string
  path: string
  sha: string
  size?: number
  type: 'file' | 'dir' | 'symlink' | 'submodule'
  download_url?: string | null
}

/** A single entry in the request body of `POST /git/trees`. */
interface GitHubTreeEntry {
  path: string
  mode: string
  type: 'blob' | 'tree' | 'commit'
  /** `null` deletes the entry from the base tree; omitted when `content` creates the blob. */
  sha?: string | null
  /** Inline content for a blob that does not exist yet (the `.gitkeep` placeholder). */
  content?: string
}

interface GitHubTreeObject {
  sha: string
  tree: GitHubTreeEntry[]
  truncated?: boolean
}

interface GitHubHead {
  commit: string
  tree: string
}

function contentEntry(item: GitHubContent): DriverEntry {
  const folder = item.type === 'dir'
  return {
    name: item.name,
    kind: folder ? 'folder' : 'file',
    size: Number(item.size) || 0,
    modifiedAt: 0,
    ref: item.sha,
    mime: folder ? 'application/octet-stream' : driverEntryMime(item.name),
  }
}

function base64Of(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function normalizeRoot(input: string): string {
  return input.replace(/^\/+|\/+$/g, '')
}

function repoDirname(path: string): string {
  if (!path) return ''
  const index = path.lastIndexOf('/')
  return index < 0 ? '' : path.slice(0, index)
}

function repoBasename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

/** A 409 is a stale base tree; a 422 is a ref update that lost the compare-and-swap race. */
function isStaleBase(error: unknown): boolean {
  return error instanceof DriverError && error.kind === 'upstream' && /HTTP (409|422)/.test(error.message)
}

export class GitHubDriver extends HttpDriverBase implements MountDriver {
  readonly definition = findCloudDriveDriver('github')!
  readonly capabilities = this.definition.capabilities
  private readonly repo: string
  private readonly branch: string
  private readonly rootPath: string
  /** Serializes every write made through this driver instance. */
  private writeQueue: Promise<unknown> = Promise.resolve()

  constructor(ctx: DriverContext) {
    super(ctx)
    this.repo = String(ctx.config.repo ?? '').trim()
    if (!this.repo.includes('/')) throw DriverError.auth('GitHub needs a repository configured as owner/name')
    this.branch = String(ctx.config.branch ?? '').trim() || 'main'
    this.rootPath = normalizeRoot(String(ctx.config.rootPath ?? ''))
  }

  private headers(accept: string): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: accept,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'inkstone-clouddrive',
    }
    const token = String(this.ctx.credentials.token ?? '')
    if (token) headers.Authorization = `Bearer ${token}`
    return headers
  }

  /**
   * GitHub has no login endpoint: the PAT is proved by the first Contents call. Validation here is
   * deliberately offline so a listing does not cost an extra `/repos` request.
   */
  protected async login(_force: boolean): Promise<void> {
    if (!this.repo) throw DriverError.auth('GitHub needs a repository configured as owner/name')
  }

  private repoPath(clean: string): string {
    const relative = clean === '/' ? '' : clean.slice(1)
    return this.rootPath ? (relative ? `${this.rootPath}/${relative}` : this.rootPath) : relative
  }

  private contentsUrl(clean: string): string {
    const path = this.repoPath(clean)
    const suffix = path
      ? `/${path.split('/').map((segment) => encodeURIComponent(segment)).join('/')}`
      : ''
    return `${API}/repos/${this.repo}/contents${suffix}?ref=${encodeURIComponent(this.branch)}`
  }

  private async readContents(url: string): Promise<GitHubContent[]> {
    const response = await this.request(url, { headers: this.headers(JSON_ACCEPT) })
    const payload = await response.json() as GitHubContent | GitHubContent[]
    if (!Array.isArray(payload)) throw DriverError.notFound('The path is not a folder')
    return payload.filter((item) => item.name !== '.gitkeep')
  }

  async list(path: string, options: DriverListOptions = {}): Promise<DriverListResult> {
    const clean = driverPath(path)
    return await this.withAuth(async () => {
      let entries = (await this.readContents(this.contentsUrl(clean))).map(contentEntry)
      if (options.search) {
        const needle = options.search.toLowerCase()
        entries = entries.filter((entry) => entry.name.toLowerCase().includes(needle))
      }
      if (options.page !== undefined) {
        const pageSize = Math.max(1, options.pageSize ?? PAGE_SIZE)
        const offset = (Math.max(1, options.page) - 1) * pageSize
        const pageEntries = entries.slice(offset, offset + pageSize)
        const nextOffset = offset + pageEntries.length < entries.length ? String(offset + pageEntries.length) : null
        return { entries: pageEntries, cursor: nextOffset, truncated: nextOffset !== null }
      }
      return { entries, cursor: null, truncated: false }
    })
  }

  async stat(path: string): Promise<DriverEntry> {
    const clean = driverPath(path)
    return await this.withAuth(async () => {
      const response = await this.request(this.contentsUrl(clean), { headers: this.headers(JSON_ACCEPT) })
      const payload = await response.json() as GitHubContent | GitHubContent[]
      if (Array.isArray(payload)) {
        return {
          name: clean === '/' ? 'root' : driverFileName(clean),
          kind: 'folder',
          size: 0,
          modifiedAt: 0,
        }
      }
      return contentEntry(payload)
    })
  }

  async read(path: string, range?: string | null): Promise<Response> {
    const clean = driverPath(path)
    return await this.withAuth(async () => {
      return await this.request(this.contentsUrl(clean), {
        headers: { ...this.headers(RAW_ACCEPT), ...(range ? { Range: range } : {}) },
        redirect: 'follow',
        timeoutMs: 30_000,
      })
    })
  }

  async directLink(path: string): Promise<string | null> {
    const clean = driverPath(path)
    return await this.withAuth(async () => {
      const response = await this.request(this.contentsUrl(clean), { headers: this.headers(JSON_ACCEPT) })
      const payload = await response.json() as GitHubContent | GitHubContent[]
      if (Array.isArray(payload)) return null
      return payload.download_url ? payload.download_url : null
    })
  }

  /** Reads the current blob sha so an overwrite PUT can use GitHub's compare-and-swap. */
  private async existingSha(url: string): Promise<string | null> {
    try {
      const response = await this.request(url, { headers: this.headers(JSON_ACCEPT) })
      const payload = await response.json() as GitHubContent | GitHubContent[]
      if (Array.isArray(payload)) throw DriverError.unsupported('A folder cannot be written as a file')
      return payload.sha || null
    } catch (error) {
      if (error instanceof DriverError && error.kind === 'not_found') return null
      throw error
    }
  }

  async upload(path: string, body: Uint8Array | ReadableStream, options: DriverUploadOptions): Promise<void> {
    const clean = driverPath(path)
    const bytes = await asBytes(body)
    if (bytes.byteLength !== options.size) throw DriverError.invalid('The upload body does not match the declared size')
    const content = base64Of(bytes)
    await this.withWriteQueue(async () => await this.withAuth(async () => {
      const url = this.contentsUrl(clean)
      const put = async (sha: string | null): Promise<void> => {
        const payload: Record<string, unknown> = {
          message: `Upload ${driverFileName(clean)}`,
          content,
          branch: this.branch,
        }
        if (sha) payload.sha = sha
        const response = await this.request(url, {
          method: 'PUT',
          headers: { ...this.headers(JSON_ACCEPT), 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        })
        await response.body?.cancel().catch(() => undefined)
      }
      try {
        await put(await this.existingSha(url))
      } catch (error) {
        // A stale sha is answered with 409 Conflict (or 422 on some GitHub-compatible hosts). Re-read
        // the current sha and retry once, which is the only way the Contents API allows an overwrite.
        if (!(error instanceof DriverError) || error.kind !== 'upstream' || !/HTTP (409|422)/.test(error.message)) throw error
        await put(await this.existingSha(url))
      }
      options.onProgress?.(bytes.byteLength, bytes.byteLength)
    }))
  }

  /** Runs `work` after the previous write on this driver has finished. */
  private async withWriteQueue<T>(work: () => Promise<T>): Promise<T> {
    const previous = this.writeQueue
    let release!: () => void
    this.writeQueue = new Promise<void>((resolve) => { release = resolve })
    await previous
    try {
      return await work()
    } finally {
      release()
    }
  }

  private gitUrl(suffix: string): string {
    return `${API}/repos/${this.repo}/git/${suffix}`
  }

  private async gitJson<T>(
    url: string,
    method: 'GET' | 'POST' | 'PATCH' = 'GET',
    body?: unknown,
  ): Promise<T> {
    // The Git Data ref update needs PATCH; the shared HttpOptions union predates that caller but
    // fetch accepts it, so the narrow cast keeps the retry/error mapping in HttpDriverBase.
    const init = {
      method,
      headers: {
        ...this.headers(JSON_ACCEPT),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    } as unknown as HttpOptions
    const response = await this.request(url, init)
    return await response.json() as T
  }

  /** Resolves the head commit and the sha of its root tree in two calls. */
  private async headTree(): Promise<GitHubHead> {
    const branch = await this.gitJson<{ commit?: { sha?: string } }>(
      `${API}/repos/${this.repo}/branches/${encodeURIComponent(this.branch)}`,
    )
    const commit = branch.commit?.sha
    if (!commit) throw DriverError.notFound(`GitHub could not resolve the branch ${this.branch}`)
    const payload = await this.gitJson<{ tree?: { sha?: string } }>(this.gitUrl(`commits/${commit}`))
    const tree = payload.tree?.sha
    if (!tree) throw DriverError.notFound(`GitHub could not resolve the tree for ${this.branch}`)
    return { commit, tree }
  }

  private async treeObject(sha: string): Promise<GitHubTreeObject> {
    const tree = await this.gitJson<GitHubTreeObject>(this.gitUrl(`trees/${sha}`))
    if (!Array.isArray(tree.tree)) throw DriverError.upstream('GitHub returned an invalid tree')
    return tree
  }

  /** Walks the repository tree to a directory, relative to the mount's configured root. */
  private async treeAt(physicalPath: string, rootTree: string): Promise<{ sha: string; tree: GitHubTreeObject }> {
    let sha = rootTree
    let tree = await this.treeObject(sha)
    for (const segment of physicalPath.split('/').filter(Boolean)) {
      const entry = tree.tree.find((item) => item.path === segment && item.type === 'tree')
      if (!entry || !entry.sha) throw DriverError.notFound(`GitHub could not resolve ${physicalPath}`)
      sha = entry.sha
      tree = await this.treeObject(sha)
    }
    return { sha, tree }
  }

  private async newTree(base: string | null, entries: GitHubTreeEntry[]): Promise<string> {
    const body: Record<string, unknown> = { tree: entries }
    if (base) body.base_tree = base
    const payload = await this.gitJson<{ sha?: string }>(this.gitUrl('trees'), 'POST', body)
    if (!payload.sha) throw DriverError.upstream('GitHub returned no tree sha')
    return payload.sha
  }

  private async commitTree(message: string, tree: string, parent: string): Promise<void> {
    const payload = await this.gitJson<{ sha?: string }>(this.gitUrl('commits'), 'POST', {
      message,
      tree,
      parents: [parent],
    })
    const commit = payload.sha
    if (!commit) throw DriverError.upstream('GitHub returned no commit sha')
    await this.gitJson(this.gitUrl(`refs/heads/${encodeURIComponent(this.branch)}`), 'PATCH', {
      sha: commit,
      force: false,
    })
  }

  /**
   * Applies edits bottom-up: each edited directory gets a new tree object whose base is its old
   * tree, and every changed child directory is substituted into its parent. The recursion rebuilds
   * only the edited branches, so unrelated trees are untouched.
   */
  private async rebuild(
    path: string,
    oldSha: string,
    edits: ReadonlyMap<string, GitHubTreeEntry[]>,
    dirty: ReadonlySet<string>,
    oldTrees: ReadonlyMap<string, { sha: string; tree: GitHubTreeObject }>,
  ): Promise<string> {
    const entries: GitHubTreeEntry[] = [...(edits.get(path) ?? [])]
    for (const childPath of dirty) {
      if (childPath === path || repoDirname(childPath) !== path) continue
      const child = oldTrees.get(childPath)
      if (!child) throw DriverError.notFound(`GitHub could not resolve ${childPath}`)
      entries.push({
        path: repoBasename(childPath),
        mode: '040000',
        type: 'tree',
        sha: await this.rebuild(childPath, child.sha, edits, dirty, oldTrees),
      })
    }
    if (entries.length === 0) return oldSha
    return await this.newTree(oldSha, entries)
  }

  private async applyEdits(head: GitHubHead, edits: Map<string, GitHubTreeEntry[]>): Promise<string> {
    const dirty = new Set<string>([''])
    for (const path of edits.keys()) {
      let current = path
      while (current) {
        dirty.add(current)
        current = repoDirname(current)
      }
    }
    const oldTrees = new Map<string, { sha: string; tree: GitHubTreeObject }>()
    for (const path of dirty) {
      if (!path) {
        oldTrees.set(path, { sha: head.tree, tree: await this.treeObject(head.tree) })
      } else {
        oldTrees.set(path, await this.treeAt(path, head.tree))
      }
    }
    return await this.rebuild('', head.tree, edits, dirty, oldTrees)
  }

  /**
   * Runs one tree-rewriting operation under the driver lock. A 409/422 means the branch moved
   * between reading the head and updating the ref, so the operation is rebuilt from the new head
   * and retried once.
   */
  private async commitWithRetry(
    message: string,
    build: (head: GitHubHead) => Promise<string>,
  ): Promise<void> {
    await this.withWriteQueue(async () => {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const head = await this.headTree()
          await this.commitTree(message, await build(head), head.commit)
          return
        } catch (error) {
          if (attempt === 0 && isStaleBase(error)) continue
          throw error
        }
      }
    })
  }

  /** A new-name argument is one path segment, never a path. */
  private safeName(name: string): string {
    const trimmed = String(name ?? '').trim().replace(/^\/+|\/+$/g, '')
    if (!trimmed || trimmed.includes('/')) throw DriverError.invalid('The new name is invalid')
    return trimmed
  }

  async remove(path: string): Promise<void> {
    const clean = driverPath(path)
    if (clean === '/') throw DriverError.invalid('The mount root cannot be removed')
    const physical = this.repoPath(clean)
    const parent = repoDirname(physical)
    const name = repoBasename(physical)
    await this.withAuth(async () => {
      await this.commitWithRetry(`Delete ${clean}`, async (head) => {
        const parentTree = await this.treeAt(parent, head.tree)
        const target = parentTree.tree.tree.find((entry) => entry.path === name)
        if (!target) throw DriverError.notFound(`GitHub could not resolve ${clean}`)
        if (target.type === 'commit') throw DriverError.unsupported('A submodule cannot be removed')
        const entries: GitHubTreeEntry[] = [{ path: name, mode: target.mode, type: target.type, sha: null }]
        // Keep a directory visible after its last real entry is deleted.
        if (parent && parentTree.tree.tree.length === 1) {
          entries.push({ path: '.gitkeep', mode: '100644', type: 'blob', content: '' })
        }
        return await this.applyEdits(head, new Map([[parent, entries]]))
      })
    })
  }

  async mkdir(path: string): Promise<void> {
    const clean = driverPath(path)
    if (clean === '/') return
    const physical = this.repoPath(clean)
    const parent = repoDirname(physical)
    const name = repoBasename(physical)
    await this.withAuth(async () => {
      await this.commitWithRetry(`Create ${clean}`, async (head) => {
        const parentTree = await this.treeAt(parent, head.tree)
        // Git cannot store an empty tree through the Contents API; a .gitkeep blob keeps the folder.
        const folder = await this.newTree(null, [{ path: '.gitkeep', mode: '100644', type: 'blob', content: '' }])
        const entries: GitHubTreeEntry[] = [{ path: name, mode: '040000', type: 'tree', sha: folder }]
        if (parentTree.tree.tree.length === 1 && parentTree.tree.tree[0]!.path === '.gitkeep') {
          entries.push({ path: '.gitkeep', mode: '100644', type: 'blob', sha: null })
        }
        return await this.applyEdits(head, new Map([[parent, entries]]))
      })
    })
  }

  async rename(path: string, newName: string): Promise<void> {
    const clean = driverPath(path)
    const physical = this.repoPath(clean)
    if (!physical) throw DriverError.invalid('The mount root cannot be renamed')
    const parent = repoDirname(physical)
    const oldName = repoBasename(physical)
    const name = this.safeName(newName)
    if (name === oldName) return
    await this.withAuth(async () => {
      await this.commitWithRetry(`Rename ${clean} to ${name}`, async (head) => {
        const parentTree = await this.treeAt(parent, head.tree)
        const target = parentTree.tree.tree.find((entry) => entry.path === oldName)
        if (!target) throw DriverError.notFound(`GitHub could not resolve ${clean}`)
        if (target.type === 'commit') throw DriverError.unsupported('A submodule cannot be renamed')
        const entries: GitHubTreeEntry[] = [
          { path: oldName, mode: target.mode, type: target.type, sha: null },
          { path: name, mode: target.mode, type: target.type, sha: target.sha },
        ]
        return await this.applyEdits(head, new Map([[parent, entries]]))
      })
    })
  }

  async move(fromPath: string, toPath: string): Promise<void> {
    const from = driverPath(fromPath)
    const to = driverPath(toPath)
    const source = this.repoPath(from)
    const destination = this.repoPath(to)
    if (!source || !destination) throw DriverError.invalid('The mount root cannot be moved')
    if (destination === source) return
    if (destination.startsWith(`${source}/`)) throw DriverError.invalid('A folder cannot be moved into itself')
    const sourceParent = repoDirname(source)
    const destinationParent = repoDirname(destination)
    const sourceName = repoBasename(source)
    const destinationName = repoBasename(destination)
    await this.withAuth(async () => {
      await this.commitWithRetry(`Move ${from} to ${to}`, async (head) => {
        const sourceTree = await this.treeAt(sourceParent, head.tree)
        const destinationTree = sourceParent === destinationParent
          ? sourceTree
          : await this.treeAt(destinationParent, head.tree)
        const target = sourceTree.tree.tree.find((entry) => entry.path === sourceName)
        if (!target) throw DriverError.notFound(`GitHub could not resolve ${from}`)
        if (target.type === 'commit') throw DriverError.unsupported('A submodule cannot be moved')
        const edits = new Map<string, GitHubTreeEntry[]>()
        if (sourceParent === destinationParent) {
          edits.set(sourceParent, [
            { path: sourceName, mode: target.mode, type: target.type, sha: null },
            { path: destinationName, mode: target.mode, type: target.type, sha: target.sha },
          ])
        } else {
          const sourceEntries: GitHubTreeEntry[] = [
            { path: sourceName, mode: target.mode, type: target.type, sha: null },
          ]
          if (sourceParent && sourceTree.tree.tree.length === 1) {
            sourceEntries.push({ path: '.gitkeep', mode: '100644', type: 'blob', content: '' })
          }
          edits.set(sourceParent, sourceEntries)
          const destinationEntries: GitHubTreeEntry[] = [
            { path: destinationName, mode: target.mode, type: target.type, sha: target.sha },
          ]
          if (destinationTree.tree.tree.length === 1 && destinationTree.tree.tree[0]!.path === '.gitkeep') {
            destinationEntries.push({ path: '.gitkeep', mode: '100644', type: 'blob', sha: null })
          }
          edits.set(destinationParent, destinationEntries)
        }
        return await this.applyEdits(head, edits)
      })
    })
  }

  async copy(fromPath: string, toPath: string): Promise<void> {
    const from = driverPath(fromPath)
    const to = driverPath(toPath)
    const source = this.repoPath(from)
    const destination = this.repoPath(to)
    if (!source || !destination) throw DriverError.invalid('The mount root cannot be copied')
    if (destination === source) throw DriverError.invalid('A path cannot be copied onto itself')
    if (destination.startsWith(`${source}/`)) throw DriverError.invalid('A folder cannot be copied into itself')
    const sourceParent = repoDirname(source)
    const destinationParent = repoDirname(destination)
    const sourceName = repoBasename(source)
    const destinationName = repoBasename(destination)
    await this.withAuth(async () => {
      await this.commitWithRetry(`Copy ${from} to ${to}`, async (head) => {
        const sourceTree = await this.treeAt(sourceParent, head.tree)
        const destinationTree = await this.treeAt(destinationParent, head.tree)
        const target = sourceTree.tree.tree.find((entry) => entry.path === sourceName)
        if (!target) throw DriverError.notFound(`GitHub could not resolve ${from}`)
        if (target.type === 'commit') throw DriverError.unsupported('A submodule cannot be copied')
        const entries: GitHubTreeEntry[] = [
          { path: destinationName, mode: target.mode, type: target.type, sha: target.sha },
        ]
        if (destinationTree.tree.tree.length === 1 && destinationTree.tree.tree[0]!.path === '.gitkeep') {
          entries.push({ path: '.gitkeep', mode: '100644', type: 'blob', sha: null })
        }
        return await this.applyEdits(head, new Map([[destinationParent, entries]]))
      })
    })
  }

  async test(): Promise<{ ok: boolean; message: string }> {
    try {
      const response = await this.request(`${API}/repos/${this.repo}`, { headers: this.headers(JSON_ACCEPT) })
      await response.body?.cancel().catch(() => undefined)
      return { ok: true, message: `GitHub is reachable · ${this.repo}` }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : 'GitHub is unavailable' }
    }
  }
}

export function createGitHubDriver(ctx: DriverContext): MountDriver {
  return new GitHubDriver(ctx)
}
