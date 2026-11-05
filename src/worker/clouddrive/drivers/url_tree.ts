/**
 * URL Tree driver — a virtual file system described by deeply-indented text.
 *
 * Ported from `OpenList-Worker/src/backend/drivers/url_tree`. Each line is indented by two spaces
 * per level; a line ending in `:` is a folder, and every other line is `[name][:size][:mtime]:URL`.
 * A file's content is the URL itself.
 *
 * The upstream keeps the structure writable by persisting the edited text back to the driver's
 * config. That callback is now part of `DriverContext` (`saveConfig`), so `writable=true` edits are
 * serialised through the shared schema validation instead of being thrown away.
 */
import { findCloudDriveDriver } from '@shared/clouddrive/drivers'
import {
  DriverError,
  asBytes,
  driverEntryMime,
  type DriverEntry,
  type DriverContext,
  type DriverListOptions,
  type DriverListResult,
  type DriverUploadOptions,
  type MountDriver,
} from './contract'
import {
  HttpDriverBase,
  driverFileName,
  driverParentPath,
  driverPath,
} from './http'

interface TreeLine {
  raw: string
  indent: number
}

interface TreeNode {
  url: string
  name: string
  level: number
  modified: number
  size: number
  children: TreeNode[]
}

function parseFileLine(line: string): TreeNode {
  const httpIndex = line.indexOf('http://')
  const httpsIndex = line.indexOf('https://')
  const index = httpIndex >= 0 ? httpIndex : httpsIndex
  if (index < 0) throw DriverError.invalid(`Invalid URL Tree line "${line}": a URL is required for a file.`)
  const url = line.slice(index)
  const info = line.slice(0, index)
  const node: TreeNode = { url, name: '', level: 0, modified: 0, size: 0, children: [] }
  if (index > 0) {
    if (!info.endsWith(':')) {
      throw DriverError.invalid(`Invalid URL Tree line "${line}": file information must end with ':'.`)
    }
    const trimmed = info.slice(0, -1)
    if (!trimmed) throw DriverError.invalid(`Invalid URL Tree line "${line}": the file name cannot be empty.`)
    const parts = trimmed.split(':')
    node.name = parts[0]!
    if (parts.length > 1) {
      const size = Number.parseInt(parts[1]!, 10)
      if (Number.isNaN(size)) {
        throw DriverError.invalid(`Invalid URL Tree line "${line}": the file size must be an integer.`)
      }
      node.size = size
      if (parts.length > 2) {
        const modified = Number.parseInt(parts[2]!, 10)
        if (Number.isNaN(modified)) {
          throw DriverError.invalid(`Invalid URL Tree line "${line}": the modified time must be a unix timestamp.`)
        }
        node.modified = modified
      }
    }
  } else {
    const parsed = new URL(url)
    const segments = parsed.pathname.split('/').filter(Boolean)
    node.name = segments[segments.length - 1] || url
  }
  return node
}

function buildTree(text: string): TreeNode {
  const root: TreeNode = { url: '', name: 'root', level: -1, modified: 0, size: 0, children: [] }
  const stack: TreeNode[] = [root]
  const lines: TreeLine[] = []
  for (const raw of text.split('\n')) {
    let indent = 0
    while (indent < raw.length && raw[indent] === ' ') indent++
    if (indent % 2 !== 0) {
      throw DriverError.invalid(`Invalid URL Tree line "${raw}": indentation must be a multiple of two spaces.`)
    }
    const content = raw.slice(indent).trim()
    if (!content) continue
    lines.push({ raw: content, indent })
  }
  for (const line of lines) {
    const level = line.indent / 2
    while (level <= stack[stack.length - 1]!.level) stack.pop()
    if (line.raw.endsWith(':')) {
      const node: TreeNode = {
        url: '',
        name: line.raw.slice(0, -1),
        level,
        modified: 0,
        size: 0,
        children: [],
      }
      stack[stack.length - 1]!.children.push(node)
      stack.push(node)
    } else {
      const node = parseFileLine(line.raw)
      node.level = level
      stack[stack.length - 1]!.children.push(node)
    }
  }
  calculateSize(root)
  return root
}

function calculateSize(node: TreeNode): number {
  if (node.url) return node.size
  let total = 0
  for (const child of node.children) total += calculateSize(child)
  node.size = total
  return total
}

/** The same textual form the reference driver writes back for `writable=true`. */
function stringifyTree(root: TreeNode): string {
  const walk = (node: TreeNode): string => {
    if (node.level === -1) return node.children.map(walk).join('\n')
    const indent = '  '.repeat(node.level)
    if (!node.url) {
      const children = node.children.map(walk).join('\n')
      return `${indent}${node.name}:${children ? `\n${children}` : ''}`
    }
    let baseName = ''
    try {
      const parsed = new URL(node.url)
      baseName = parsed.pathname.split('/').filter(Boolean).pop() ?? ''
    } catch {
      baseName = ''
    }
    if (node.size === 0 && node.modified === 0) {
      return `${indent}${baseName === node.name ? node.url : `${node.name}:${node.url}`}`
    }
    let info = node.name
    if (node.size !== 0 || node.modified !== 0) info += `:${node.size}`
    if (node.modified !== 0) info += `:${node.modified}`
    return `${indent}${info}:${node.url}`
  }
  return walk(root)
}

function deepCopy(node: TreeNode, level: number): TreeNode {
  return {
    url: node.url,
    name: node.name,
    level,
    modified: node.modified,
    size: node.size,
    children: node.children.map((child) => deepCopy(child, level + 1)),
  }
}

function splitPath(path: string): string[] {
  if (path === '/' || !path) return ['root']
  return ['root', ...path.split('/').filter(Boolean)]
}

function nodeByPath(root: TreeNode, path: string): TreeNode | null {
  const segments = splitPath(path)
  let node: TreeNode | null = root
  for (let index = 0; index < segments.length; index++) {
    if (!node) return null
    if (node.name !== segments[index]) return null
    if (index === segments.length - 1) return node
    node = node.children.find((child) => child.name === segments[index + 1]) ?? null
  }
  return node
}

function parseRange(value: string | null | undefined, size: number): { start: number; end: number } | null {
  if (!value) return null
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim())
  if (!match) return null
  const first = match[1] ?? ''
  const second = match[2] ?? ''
  if (!first && !second) return null
  if (!first) {
    const suffix = Number(second)
    if (!Number.isFinite(suffix) || suffix <= 0) return null
    return { start: Math.max(0, size - suffix), end: size - 1 }
  }
  const start = Number(first)
  if (!Number.isFinite(start) || start >= size) return null
  const end = second ? Math.min(Number(second), size - 1) : size - 1
  if (!Number.isFinite(end) || end < start) return null
  return { start, end }
}

class UrlTreeDriver extends HttpDriverBase implements MountDriver {
  readonly definition = findCloudDriveDriver('url_tree')!
  readonly capabilities = this.definition.capabilities
  private root: TreeNode | null = null
  private readonly headSizes = new Map<string, number>()

  constructor(ctx: DriverContext) {
    super(ctx)
  }

  protected async login(_force: boolean): Promise<void> {
    const structure = this.configText('urlStructure')
    if (!structure.trim()) throw DriverError.invalid('URL Tree needs a non-empty urlStructure.')
    this.root = buildTree(structure)
    this.headSizes.clear()
  }

  private async tree(): Promise<TreeNode> {
    await this.authenticate(false)
    if (!this.root) throw DriverError.invalid('URL Tree has not been parsed yet.')
    return this.root
  }

  private treePath(path: string): string {
    const clean = driverPath(path)
    const root = driverPath(this.configText('rootPath', '/'))
    if (root === '/') return clean
    return clean === '/' ? root : `${root}${clean}`
  }

  private async node(path: string): Promise<TreeNode> {
    const tree = await this.tree()
    const node = nodeByPath(tree, this.treePath(path))
    if (!node) throw DriverError.notFound(`URL Tree has no entry at ${path}`)
    return node
  }

  private writable(): boolean {
    const value = this.ctx.config.writable
    return value === true || value === 'true' || value === 1 || value === '1'
  }

  private headSize(): boolean {
    const value = this.ctx.config.headSize
    return value === true || value === 'true' || value === 1 || value === '1'
  }

  private async resolveSize(node: TreeNode): Promise<number> {
    if (!node.url || node.size > 0 || !this.headSize()) return node.size
    const cached = this.headSizes.get(node.url)
    if (cached !== undefined) return cached
    try {
      const response = await fetch(node.url, {
        method: 'HEAD',
        redirect: 'follow',
        signal: AbortSignal.timeout(20_000),
      })
      await response.body?.cancel().catch(() => undefined)
      const length = Number.parseInt(response.headers.get('content-length') ?? '0', 10)
      const size = Number.isFinite(length) && length > 0 ? length : 0
      this.headSizes.set(node.url, size)
      return size
    } catch {
      return 0
    }
  }

  private entryFor(node: TreeNode): DriverEntry {
    const folder = !node.url
    return {
      name: node.name,
      kind: folder ? 'folder' : 'file',
      size: node.size,
      modifiedAt: node.modified > 0 ? node.modified * 1000 : 0,
      ref: node.url || undefined,
      mime: folder ? 'application/octet-stream' : driverEntryMime(node.name),
    }
  }

  async list(path: string, _options: DriverListOptions = {}): Promise<DriverListResult> {
    const clean = driverPath(path)
    const node = await this.node(clean)
    if (node.url) throw DriverError.invalid(`URL Tree entry "${clean}" is not a folder.`)
    const entries = node.children
      .map((child) => this.entryFor(child))
      .sort((left, right) => left.name.localeCompare(right.name))
    return { entries, cursor: null, truncated: false }
  }

  async stat(path: string): Promise<DriverEntry> {
    const clean = driverPath(path)
    const node = await this.node(clean)
    const entry = this.entryFor(node)
    if (entry.kind === 'file') {
      const size = await this.resolveSize(node)
      if (size !== entry.size) entry.size = size
    }
    return entry
  }

  async read(path: string, range?: string | null): Promise<Response> {
    const clean = driverPath(path)
    const node = await this.node(clean)
    if (!node.url) throw DriverError.unsupported('A folder cannot be read as a file')
    const body = node.url
    const bytes = new TextEncoder().encode(body)
    const slice = parseRange(range, bytes.byteLength)
    const headers = new Headers({
      'content-type': 'text/plain; charset=utf-8',
      'accept-ranges': 'bytes',
    })
    if (!slice) {
      headers.set('content-length', String(bytes.byteLength))
      return new Response(body, { status: 200, headers })
    }
    const chunk = bytes.slice(slice.start, slice.end + 1)
    headers.set('content-length', String(chunk.byteLength))
    headers.set('content-range', `bytes ${slice.start}-${slice.end}/${bytes.byteLength}`)
    return new Response(chunk, { status: 206, headers })
  }

  private requireWritable(): void {
    if (!this.writable()) throw DriverError.unsupported('URL Tree is read-only; set writable=true to edit it')
    if (!this.ctx.saveConfig) throw DriverError.unsupported('URL Tree cannot persist edits without a config write-back callback')
  }

  private async persist(): Promise<void> {
    const tree = await this.tree()
    await this.ctx.saveConfig!({ urlStructure: stringifyTree(tree) })
  }

  private async parentNode(path: string): Promise<TreeNode> {
    const tree = await this.tree()
    const parent = nodeByPath(tree, driverParentPath(this.treePath(path)))
    if (!parent) throw DriverError.notFound(`URL Tree has no folder at ${driverParentPath(path)}`)
    if (parent.url) throw DriverError.invalid(`URL Tree entry "${path}" is not a folder.`)
    return parent
  }

  async upload(
    path: string,
    body: Uint8Array | ReadableStream,
    options: DriverUploadOptions,
  ): Promise<void> {
    this.requireWritable()
    const parent = await this.parentNode(path)
    const bytes = await asBytes(body)
    if (bytes.byteLength !== options.size) throw DriverError.invalid('The upload body does not match the declared size')
    const name = driverFileName(driverPath(path))
    const data = new TextDecoder().decode(bytes).trim()
    const node = parseFileLine(`${name}:${data}`)
    node.level = parent.level + 1
    parent.children = parent.children.filter((child) => child.name !== name)
    parent.children.push(node)
    if (this.headSize()) node.size = await this.resolveSize(node)
    calculateSize((await this.tree()))
    await this.persist()
    options.onProgress?.(bytes.byteLength, bytes.byteLength)
  }

  async mkdir(path: string): Promise<void> {
    this.requireWritable()
    const parent = await this.parentNode(path)
    const name = driverFileName(driverPath(path))
    if (parent.children.some((child) => child.name === name)) throw DriverError.invalid(`URL Tree already has "${name}"`)
    parent.children.push({ url: '', name, level: parent.level + 1, modified: 0, size: 0, children: [] })
    await this.persist()
  }

  async rename(path: string, newName: string): Promise<void> {
    this.requireWritable()
    const node = await this.node(driverPath(path))
    if (node === (await this.tree())) throw DriverError.invalid('The URL Tree root cannot be renamed')
    node.name = newName
    await this.persist()
  }

  async remove(path: string): Promise<void> {
    this.requireWritable()
    const parent = await this.parentNode(path)
    const name = driverFileName(driverPath(path))
    const index = parent.children.findIndex((child) => child.name === name)
    if (index < 0) throw DriverError.notFound(`URL Tree has no entry "${name}"`)
    parent.children.splice(index, 1)
    calculateSize(await this.tree())
    await this.persist()
  }

  async move(fromPath: string, toPath: string): Promise<void> {
    this.requireWritable()
    const sourceParent = await this.parentNode(fromPath)
    const sourceName = driverFileName(driverPath(fromPath))
    const index = sourceParent.children.findIndex((child) => child.name === sourceName)
    if (index < 0) throw DriverError.notFound(`URL Tree has no entry "${sourceName}"`)
    const destinationParent = await this.parentNode(toPath)
    const [node] = sourceParent.children.splice(index, 1)
    node!.name = driverFileName(driverPath(toPath))
    node!.level = destinationParent.level + 1
    destinationParent.children.push(node!)
    calculateSize(await this.tree())
    await this.persist()
  }

  async copy(fromPath: string, toPath: string): Promise<void> {
    this.requireWritable()
    const sourceParent = await this.parentNode(fromPath)
    const sourceName = driverFileName(driverPath(fromPath))
    const source = sourceParent.children.find((child) => child.name === sourceName)
    if (!source) throw DriverError.notFound(`URL Tree has no entry "${sourceName}"`)
    const destinationParent = await this.parentNode(toPath)
    const copy = deepCopy(source, destinationParent.level + 1)
    copy.name = driverFileName(driverPath(toPath))
    destinationParent.children.push(copy)
    calculateSize(await this.tree())
    await this.persist()
  }

  async test(): Promise<{ ok: boolean; message: string }> {
    try {
      const tree = await this.tree()
      return {
        ok: true,
        message: `URL Tree is ready · ${tree.children.length} top-level entries`,
      }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : 'URL Tree is misconfigured' }
    }
  }
}

export function createUrlTreeDriver(ctx: DriverContext): MountDriver {
  return new UrlTreeDriver(ctx)
}
