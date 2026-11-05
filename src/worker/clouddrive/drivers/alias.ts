/**
 * Alias driver — exposes several mounted storages under one virtual path tree.
 *
 * Ported from `OpenList-Worker/src/backend/drivers/alias`. `paths` is a newline-separated list of
 * `aliasSubPath:mountReference` pairs; a line without a colon maps the root `/` to that mount, and
 * several lines may name the same alias sub-path (or all name `/`) to merge their listings.
 *
 * Conflict policies decide what happens when one virtual path maps to several mounts:
 *
 * - `read`: `first` uses (and merges in favour of) the first target; `random` picks a target with a
 *   hash of the path, so repeated reads keep landing on the same one; `all` tries every target in
 *   order. Listings always query every target, and duplicate names are resolved by the policy
 *   rather than silently overwritten.
 * - `write` / `put`: `disabled` refuses; `first` (and `deterministic*`) writes to the first target;
 *   `all` writes to every target and fails only when every write failed; `all_strict` fails the
 *   whole operation as soon as one target fails.
 */
import { findCloudDriveDriver } from '@shared/clouddrive/drivers'
import {
  DriverError,
  asBytes,
  type DriverContext,
  type DriverEntry,
  type DriverListOptions,
  type DriverListResult,
  type DriverUploadOptions,
  type MountDriver,
  type ResolvedMount,
} from './contract'
import { driverPath } from './http'

type ReadPolicy = 'first' | 'random' | 'all'
type WritePolicy =
  | 'disabled'
  | 'first'
  | 'deterministic'
  | 'deterministic_or_all'
  | 'all'
  | 'all_strict'
type PutPolicy = WritePolicy | 'random' | 'quota' | 'quota_strict'

const READ_POLICIES: readonly ReadPolicy[] = ['first', 'random', 'all']
const WRITE_POLICIES: readonly WritePolicy[] = [
  'disabled', 'first', 'deterministic', 'deterministic_or_all', 'all', 'all_strict',
]
const PUT_POLICIES: readonly PutPolicy[] = [...WRITE_POLICIES, 'random', 'quota', 'quota_strict']

interface AliasPair {
  aliasSubPath: string
  reference: string
}

interface AliasTarget {
  mount: ResolvedMount
  path: string
}

interface AliasMapping {
  reference: string
  path: string
}

function stableHash(value: string): number {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash >>> 0
}

function stableIndex(value: string, length: number): number {
  return length <= 0 ? 0 : stableHash(value) % length
}

/** AList's convention: folders first, then the requested key, ascending by default. */
function sortEntries(entries: DriverEntry[], orderBy: string, orderDirection: string): DriverEntry[] {
  const descending = orderDirection.toLowerCase() === 'desc'
  const key = (orderBy || 'name').toLowerCase()
  return [...entries].sort((left, right) => {
    if (left.kind !== right.kind) return left.kind === 'folder' ? -1 : 1
    let compared: number
    if (key.includes('size')) {
      compared = left.size - right.size
    } else if (key.includes('time') || key.includes('modified') || key.includes('created')) {
      compared = left.modifiedAt - right.modifiedAt
    } else {
      compared = left.name.localeCompare(right.name)
    }
    return descending ? -compared : compared
  })
}

function isWritePolicy(value: string): value is WritePolicy {
  return (WRITE_POLICIES as readonly string[]).includes(value)
}

function isPutPolicy(value: string): value is PutPolicy {
  return (PUT_POLICIES as readonly string[]).includes(value)
}

class AliasDriver implements MountDriver {
  readonly definition = findCloudDriveDriver('alias')!
  readonly capabilities = this.definition.capabilities
  private readonly pairs: AliasPair[] = []
  private readonly pathMap = new Map<string, AliasPair[]>()
  private readonly rootOrder: string[] = []
  private readonly readPolicy: ReadPolicy
  private readonly writePolicy: WritePolicy
  private readonly putPolicy: PutPolicy
  private readonly orderBy: string
  private readonly orderDirection: string
  private readonly consistencyCheck: boolean

  constructor(private readonly ctx: DriverContext) {
    this.parsePairs()
    this.readPolicy = this.policy<ReadPolicy>('readConflictPolicy', 'first', READ_POLICIES)
    this.writePolicy = this.policy<WritePolicy>('writeConflictPolicy', 'disabled', WRITE_POLICIES)
    this.putPolicy = this.policy<PutPolicy>('putConflictPolicy', 'disabled', PUT_POLICIES)
    this.orderBy = this.configText('orderBy', 'name')
    this.orderDirection = this.configText('orderDirection', 'asc')
    this.consistencyCheck = this.configBoolean('fileConsistencyCheck')
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

  private policy<T extends string>(key: string, fallback: T, allowed: readonly T[]): T {
    const raw = this.configText(key, fallback)
    const value = (raw.trim() || fallback).toLowerCase()
    if (!(allowed as readonly string[]).includes(value)) {
      throw DriverError.invalid(`Alias ${key} "${raw}" is not a known conflict policy.`)
    }
    return value as T
  }

  private cleanPath(input: string): string {
    return driverPath(input)
  }

  /**
   * `alias[:target]` per line. A line without a colon maps `/` to the target, matching the
   * reference parser. A line whose colon is the first character is also treated as a bare target
   * because the reference only splits at `indexOf(":") > 0`.
   */
  private parsePairs(): void {
    const lines = stringOf(this.ctx.config.paths)
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
    if (lines.length === 0) throw DriverError.invalid('Alias needs at least one path mapping.')
    for (const line of lines) {
      let aliasSubPath = '/'
      let reference = line
      const colon = line.indexOf(':')
      if (colon > 0) {
        aliasSubPath = this.cleanPath(line.slice(0, colon))
        reference = line.slice(colon + 1).trim()
      }
      if (!reference) throw DriverError.invalid(`Alias mapping "${line}" has no target mount.`)
      const pair: AliasPair = { aliasSubPath, reference }
      this.pairs.push(pair)
      const bucket = this.pathMap.get(aliasSubPath)
      if (bucket) {
        bucket.push(pair)
        continue
      }
      this.rootOrder.push(aliasSubPath)
      this.pathMap.set(aliasSubPath, [pair])
    }
  }

  /** The reference's `getTargetsForPath`, adapted to resolve mount-relative paths. */
  private mappingsForPath(clean: string): AliasMapping[] {
    const mappings: AliasMapping[] = []
    if (this.rootOrder.length === 1 && this.rootOrder[0] === '/') {
      for (const pair of this.pathMap.get('/') ?? []) {
        mappings.push({ reference: pair.reference, path: clean })
      }
      return mappings
    }
    for (const [aliasSubPath, pairs] of this.pathMap) {
      if (aliasSubPath === clean) {
        for (const pair of pairs) mappings.push({ reference: pair.reference, path: '/' })
        continue
      }
      const prefix = aliasSubPath === '/' ? '/' : `${aliasSubPath}/`
      if (!clean.startsWith(prefix)) continue
      const subPath = clean.slice(aliasSubPath === '/' ? 0 : aliasSubPath.length)
      for (const pair of pairs) mappings.push({ reference: pair.reference, path: subPath || '/' })
    }
    return mappings
  }

  /** Resolves every mapping, so an invalid/unauthorised/cyclic mount fails the whole operation. */
  private async targetsFor(clean: string): Promise<AliasTarget[]> {
    const mappings = this.mappingsForPath(clean)
    if (mappings.length === 0) throw DriverError.notFound(`Alias has no target for ${clean}.`)
    if (!this.ctx.resolveMount) {
      throw DriverError.unsupported('Alias needs the host that resolves cross-mount paths.')
    }
    return await Promise.all(mappings.map(async (mapping) => ({
      mount: await this.ctx.resolveMount!(mapping.reference),
      path: mapping.path,
    })))
  }

  private selectRead(targets: AliasTarget[], clean: string): AliasTarget[] {
    if (targets.length === 0) throw DriverError.notFound(`Alias has no target for ${clean}.`)
    if (this.readPolicy === 'first') return [targets[0]!]
    if (this.readPolicy === 'random') return [targets[stableIndex(clean, targets.length)]!]
    return targets
  }

  /** Calls the chosen read targets and returns the first success; `all` keeps trying. */
  private async firstSuccess<T>(targets: AliasTarget[], work: (target: AliasTarget) => Promise<T>): Promise<T> {
    let firstError: unknown = null
    for (const target of targets) {
      try {
        return await work(target)
      } catch (error) {
        if (firstError === null) firstError = error
        if (this.readPolicy !== 'all') break
      }
    }
    if (firstError !== null) throw firstError
    throw DriverError.notFound('Alias has no readable target.')
  }

  private writeSelection(policy: WritePolicy | PutPolicy, targets: AliasTarget[], clean: string): AliasTarget[] {
    if (policy === 'disabled') {
      throw DriverError.unsupported(`Alias ${policy} conflict policy refuses this write.`)
    }
    if (!isWritePolicy(policy) && !isPutPolicy(policy)) {
      throw DriverError.invalid(`Alias conflict policy "${policy}" is not supported.`)
    }
    if (policy === 'all' || policy === 'all_strict') return targets
    if (policy === 'random' || policy === 'quota' || policy === 'quota_strict') {
      return [targets[stableIndex(clean, targets.length)]!]
    }
    return [targets[0]!]
  }

  private async runWrites(targets: AliasTarget[], policy: WritePolicy | PutPolicy, work: (target: AliasTarget) => Promise<void>): Promise<void> {
    const strict = policy === 'all_strict' || policy === 'quota_strict'
    let firstError: unknown = null
    let succeeded = 0
    for (const target of targets) {
      try {
        await work(target)
        succeeded++
      } catch (error) {
        if (firstError === null) firstError = error
        if (strict) throw error
      }
    }
    if (firstError !== null && succeeded === 0) throw firstError
  }

  async list(path: string, options: DriverListOptions = {}): Promise<DriverListResult> {
    const clean = this.cleanPath(path)
    if (clean === '/' && this.rootOrder.length > 1) {
      const entries: DriverEntry[] = []
      for (const aliasSubPath of this.rootOrder) {
        const firstSegment = aliasSubPath.replace(/^\//, '').split('/')[0] ?? ''
        if (!firstSegment || entries.some((entry) => entry.name === firstSegment)) continue
        entries.push({ name: firstSegment, kind: 'folder', size: 0, modifiedAt: Date.now() })
      }
      return {
        entries: sortEntries(entries, this.orderBy, this.orderDirection),
        cursor: null,
        truncated: false,
      }
    }

    const targets = await this.targetsFor(clean)
    let firstError: unknown = null
    let succeeded = 0
    const groups = new Map<string, DriverEntry[]>()
    let truncated = false
    for (const target of targets) {
      try {
        const result = await target.mount.driver.list(target.path, options)
        succeeded++
        truncated = truncated || result.truncated
        // Keep the target order inside each name group: it is what "first occurrence wins" and
        // the stable random pick both index into.
        for (const entry of result.entries) {
          const bucket = groups.get(entry.name)
          if (bucket) bucket.push(entry)
          else groups.set(entry.name, [entry])
        }
      } catch (error) {
        if (firstError === null) firstError = error
      }
    }
    if (succeeded === 0) {
      if (firstError !== null) throw firstError
      throw DriverError.notFound(`Alias has no target for ${clean}.`)
    }

    const entries: DriverEntry[] = []
    for (const [name, candidates] of groups) {
      if (candidates.length === 0) continue
      if (this.readPolicy === 'random') {
        entries.push(candidates[stableIndex(`${clean}\n${name}`, candidates.length)]!)
      } else {
        // `first` and `all` both keep the first occurrence. `all` still queried every target
        // above; the duplicate is returned once with the first target's entry.
        entries.push(candidates[0]!)
      }
    }
    return {
      entries: sortEntries(entries, this.orderBy, this.orderDirection),
      cursor: null,
      truncated,
    }
  }

  async stat(path: string): Promise<DriverEntry> {
    const clean = this.cleanPath(path)
    if (clean === '/' && this.rootOrder.length > 1) {
      return { name: 'root', kind: 'folder', size: 0, modifiedAt: Date.now() }
    }
    return await this.firstSuccess(
      this.selectRead(await this.targetsFor(clean), clean),
      (target) => target.mount.driver.stat(target.path),
    )
  }

  async read(path: string, range?: string | null): Promise<Response> {
    const clean = this.cleanPath(path)
    const targets = this.selectRead(await this.targetsFor(clean), clean)
    const response = await this.firstSuccess(targets, (target) => target.mount.driver.read(target.path, range))
    if (this.consistencyCheck) {
      const declared = response.headers.get('content-length')
      if (declared !== null) {
        const target = targets[0]!
        const entry = await target.mount.driver.stat(target.path)
        if (Number(declared) !== entry.size) {
          throw DriverError.upstream('Alias file consistency check failed: the size changed while reading.')
        }
      }
    }
    return response
  }

  async directLink(path: string): Promise<string | null> {
    const clean = this.cleanPath(path)
    const targets = this.selectRead(await this.targetsFor(clean), clean)
    let firstError: unknown = null
    for (const target of targets) {
      if (!target.mount.driver.directLink) {
        if (this.readPolicy !== 'all') return null
        continue
      }
      try {
        return await target.mount.driver.directLink(target.path)
      } catch (error) {
        if (firstError === null) firstError = error
        if (this.readPolicy !== 'all') throw error
      }
    }
    if (firstError !== null) throw firstError
    return null
  }

  async upload(path: string, body: Uint8Array | ReadableStream, options: DriverUploadOptions): Promise<void> {
    const clean = this.cleanPath(path)
    const targets = this.writeSelection(this.putPolicy, await this.targetsFor(clean), clean)
    const payload = targets.length > 1 ? await asBytes(body) : body
    await this.runWrites(targets, this.putPolicy, (target) =>
      target.mount.driver.upload(target.path, payload, options))
  }

  async mkdir(path: string): Promise<void> {
    const clean = this.cleanPath(path)
    const targets = this.writeSelection(this.writePolicy, await this.targetsFor(clean), clean)
    await this.runWrites(targets, this.writePolicy, (target) => target.mount.driver.mkdir(target.path))
  }

  async rename(path: string, newName: string): Promise<void> {
    const clean = this.cleanPath(path)
    const targets = this.writeSelection(this.writePolicy, await this.targetsFor(clean), clean)
    await this.runWrites(targets, this.writePolicy, (target) =>
      target.mount.driver.rename(target.path, newName))
  }

  async remove(path: string): Promise<void> {
    const clean = this.cleanPath(path)
    const targets = this.writeSelection(this.writePolicy, await this.targetsFor(clean), clean)
    await this.runWrites(targets, this.writePolicy, (target) => target.mount.driver.remove(target.path))
  }

  /** Pairs the source and destination selections; a short side reuses its last target. */
  private async runPairs(
    sources: AliasTarget[],
    destinations: AliasTarget[],
    policy: WritePolicy,
    work: (source: AliasTarget, destination: AliasTarget) => Promise<void>,
  ): Promise<void> {
    const strict = policy === 'all_strict'
    const count = Math.max(sources.length, destinations.length)
    let firstError: unknown = null
    let succeeded = 0
    for (let index = 0; index < count; index++) {
      const source = sources[Math.min(index, sources.length - 1)]!
      const destination = destinations[Math.min(index, destinations.length - 1)]!
      try {
        await work(source, destination)
        succeeded++
      } catch (error) {
        if (firstError === null) firstError = error
        if (strict) throw error
      }
    }
    if (firstError !== null && succeeded === 0) throw firstError
  }

  async move(fromPath: string, toPath: string): Promise<void> {
    const from = this.cleanPath(fromPath)
    const to = this.cleanPath(toPath)
    const sources = this.writeSelection(this.writePolicy, await this.targetsFor(from), from)
    const destinations = this.writeSelection(this.writePolicy, await this.targetsFor(to), to)
    await this.runPairs(sources, destinations, this.writePolicy, (source, destination) =>
      source.mount.driver.move(source.path, destination.path))
  }

  async copy(fromPath: string, toPath: string): Promise<void> {
    const from = this.cleanPath(fromPath)
    const to = this.cleanPath(toPath)
    const sources = this.writeSelection(this.writePolicy, await this.targetsFor(from), from)
    const destinations = this.writeSelection(this.writePolicy, await this.targetsFor(to), to)
    await this.runPairs(sources, destinations, this.writePolicy, async (source, destination) => {
      if (!source.mount.driver.copy) {
        throw DriverError.unsupported('The target storage cannot copy files.')
      }
      await source.mount.driver.copy(source.path, destination.path)
    })
  }

  async test(): Promise<{ ok: boolean; message: string }> {
    try {
      if (!this.ctx.resolveMount) throw DriverError.unsupported('Alias needs a cross-mount resolver.')
      const mounts = new Set<string>()
      for (const pair of this.pairs) {
        mounts.add((await this.ctx.resolveMount(pair.reference)).mountId)
      }
      return { ok: true, message: `Alias maps ${this.pairs.length} path(s) onto ${mounts.size} mount(s)` }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : 'Alias is unavailable' }
    }
  }
}

function stringOf(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

export function createAliasDriver(ctx: DriverContext): MountDriver {
  return new AliasDriver(ctx)
}
