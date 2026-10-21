export const MEMO_EXPORT_FORMAT = 'memos-export'
export const MEMO_EXPORT_LEGACY_FORMAT = 'memos-archive'
export const MEMO_EXPORT_FORMAT_VERSION = '1.0'
export const MEMO_EXPORT_MANIFEST_ENTRY = 'manifest.json'
export const MEMO_EXPORT_GENERATOR_NAME = 'inkstone'
export const MEMO_EXPORT_MAX_ENTRIES = 10_000
export const MEMO_EXPORT_MAX_TOTAL_BYTES = 64 * 1024 * 1024

export const MEMO_EXPORT_STATES = ['NORMAL', 'ARCHIVED'] as const
export type MemoExportState = (typeof MEMO_EXPORT_STATES)[number]

export const MEMO_EXPORT_VISIBILITIES = ['PRIVATE', 'PROTECTED', 'PUBLIC', 'SPACE'] as const
export type MemoExportVisibility = (typeof MEMO_EXPORT_VISIBILITIES)[number]

export const MEMO_EXPORT_RELATION_TYPES = ['REFERENCE'] as const
export type MemoExportRelationType = (typeof MEMO_EXPORT_RELATION_TYPES)[number]

export type MemoExportManifestFormat = typeof MEMO_EXPORT_FORMAT | typeof MEMO_EXPORT_LEGACY_FORMAT

export interface MemoExportGenerator {
  name: string
  version: string
}

export interface MemoExportUser {
  username: string
  displayName?: string
}

export interface MemoExportScope {
  kind: 'USER'
  user: MemoExportUser
}

export interface MemoExportCounts {
  memos?: number
  attachments?: number
}

export interface MemoExportManifest {
  format: MemoExportManifestFormat
  formatVersion: string
  generator: MemoExportGenerator
  exportTime: string
  scope: MemoExportScope
  counts?: MemoExportCounts
}

export interface MemoExportLocation {
  placeholder?: string
  latitude?: number
  longitude?: number
}

export interface MemoExportSpace {
  uid: string
  title?: string
}

export interface MemoExportRelation {
  type: MemoExportRelationType
  memo: string
}

export interface MemoExportMediaMetadata {
  width?: number
  height?: number
  photo?: Record<string, unknown>
  video?: Record<string, unknown>
}

export interface MemoExportAttachment {
  uid: string
  filename: string
  type: string
  size: number
  sha256?: string
  path?: string
  externalLink?: string
  createTime: string
  mediaMetadata?: MemoExportMediaMetadata
}

export interface MemoExportReaction {
  reactionType: string
  creator: string
  createTime?: string
}

export interface MemoExportMemoRecord {
  uid: string
  creator: string
  createTime: string
  updateTime: string
  state: MemoExportState
  visibility: MemoExportVisibility
  pinned: boolean
  contentPath: string
  tags?: string[]
  location?: MemoExportLocation
  space?: MemoExportSpace
  parent?: string
  relations?: MemoExportRelation[]
  attachments?: MemoExportAttachment[]
  reactions?: MemoExportReaction[]
}

export class MemoExportFormatError extends Error {
  constructor(message: string, readonly path: string) {
    super(`${message}: ${path}`)
    this.name = 'MemoExportFormatError'
  }
}

const UID_PATTERN = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,34}[a-zA-Z0-9])?$/
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/
const ENTRY_PATH_PATTERN = /^(?!\/)(?!.*(?:^|\/)\.{1,2}(?:\/|$))[^\\:\u0000-\u001F]+$/
const MEDIA_TYPE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}$/
const SHA256_PATTERN = /^[0-9a-f]{64}$/
const WINDOWS_DEVICE_NAME_PATTERN = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/i

export function isMemoExportUid(value: unknown): value is string {
  return typeof value === 'string' && UID_PATTERN.test(value)
}

export function isMemoExportTimestamp(value: unknown): value is string {
  return typeof value === 'string'
    && TIMESTAMP_PATTERN.test(value)
    && !Number.isNaN(Date.parse(value))
}

export function isMemoExportEntryPath(value: unknown): value is string {
  return typeof value === 'string'
    && ENTRY_PATH_PATTERN.test(value)
    && !value.endsWith('/')
}

export function isMemoExportMediaType(value: unknown): value is string {
  return typeof value === 'string' && MEDIA_TYPE_PATTERN.test(value)
}

export function isMemoExportSha256(value: unknown): value is string {
  return typeof value === 'string' && SHA256_PATTERN.test(value)
}

export function memoExportTimestamp(unixSeconds: number): string {
  if (!Number.isFinite(unixSeconds)) {
    throw new MemoExportFormatError('Expected a finite Unix second value', 'timestamp')
  }
  const date = new Date(Math.trunc(unixSeconds) * 1000)
  if (Number.isNaN(date.getTime())) {
    throw new MemoExportFormatError('Expected a valid Unix second value', 'timestamp')
  }
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z')
}

export function memoExportSafeFilename(filename: string): string {
  const replaced = filename
    .replace(/[/\\:\u0000-\u001F]/g, '_')
    .replace(/^[ .]+|[ .]+$/g, '')
  const safe = WINDOWS_DEVICE_NAME_PATTERN.test(replaced) ? `_${replaced}` : replaced
  return safe || 'file'
}

export function memoExportMemoJsonPath(uid: string): string {
  requireUid(uid, 'uid')
  return `memos/${uid}.json`
}

export function memoExportMemoContentPath(uid: string): string {
  requireUid(uid, 'uid')
  return `memos/${uid}.md`
}

export function memoExportAttachmentPath(uid: string, filename: string): string {
  requireUid(uid, 'uid')
  return `attachments/${uid}/${memoExportSafeFilename(filename)}`
}

export function memoExportArchiveFilename(username: string, exportTime: string): string {
  if (!username) throw new MemoExportFormatError('Expected a username', 'username')
  if (!isMemoExportTimestamp(exportTime)) {
    throw new MemoExportFormatError('Expected an RFC 3339 UTC timestamp', 'exportTime')
  }
  const compact = exportTime.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
  return `memos-export-${username}-${compact}.zip`
}

function requireUid(uid: string, path: string): void {
  if (!isMemoExportUid(uid)) throw new MemoExportFormatError('Expected a valid UID', path)
}

export function parseMemoExportManifest(value: unknown): MemoExportManifest {
  const root = recordAt(value, 'manifest')
  const format = oneOfAt(root, 'format', 'manifest.format', [
    MEMO_EXPORT_FORMAT,
    MEMO_EXPORT_LEGACY_FORMAT,
  ] as const)
  const formatVersion = stringAt(root, 'formatVersion', 'manifest.formatVersion')
  if (!/^1\.\d+$/.test(formatVersion)) {
    throw new MemoExportFormatError(`Unsupported format version ${formatVersion}`, 'manifest.formatVersion')
  }

  const generator = recordAt(root.generator, 'manifest.generator')
  const generatorName = nonEmptyStringAt(generator, 'name', 'manifest.generator.name')
  const generatorVersion = nonEmptyStringAt(generator, 'version', 'manifest.generator.version')

  const exportTime = timestampAt(root, 'exportTime', 'manifest.exportTime')
  const scope = recordAt(root.scope, 'manifest.scope')
  const kind = oneOfAt(scope, 'kind', 'manifest.scope.kind', ['USER'] as const)
  const user = recordAt(scope.user, 'manifest.scope.user')
  const username = nonEmptyStringAt(user, 'username', 'manifest.scope.user.username')
  const displayName = optionalStringAt(user, 'displayName', 'manifest.scope.user.displayName')
  const counts = root.counts === undefined ? undefined : parseCounts(root.counts)

  return {
    format,
    formatVersion,
    generator: { name: generatorName, version: generatorVersion },
    exportTime,
    scope: {
      kind,
      user: {
        username,
        ...(displayName !== undefined ? { displayName } : {}),
      },
    },
    ...(counts !== undefined ? { counts } : {}),
  }
}

export function parseMemoExportMemoRecord(value: unknown): MemoExportMemoRecord {
  const root = recordAt(value, 'memo')
  const uid = uidAt(root, 'uid', 'memo.uid')
  const creator = nonEmptyStringAt(root, 'creator', 'memo.creator')
  const createTime = timestampAt(root, 'createTime', 'memo.createTime')
  const updateTime = timestampAt(root, 'updateTime', 'memo.updateTime')
  const state = oneOfAt(root, 'state', 'memo.state', MEMO_EXPORT_STATES)
  const visibility = oneOfAt(root, 'visibility', 'memo.visibility', MEMO_EXPORT_VISIBILITIES)
  const pinned = booleanAt(root, 'pinned', 'memo.pinned')
  const contentPath = entryPathAt(root, 'contentPath', 'memo.contentPath')
  const tags = optionalArrayAt(root, 'tags', 'memo.tags')
    ?.map((item, index) => nonEmptyStringValue(item, `memo.tags[${index}]`))
  const location = root.location === undefined ? undefined : parseLocation(root.location)
  const space = root.space === undefined ? undefined : parseSpace(root.space)
  const parent = root.parent === undefined ? undefined : uidValue(root.parent, 'memo.parent')
  const relations = optionalArrayAt(root, 'relations', 'memo.relations')
    ?.map((item, index) => parseRelation(item, index))
  const attachments = optionalArrayAt(root, 'attachments', 'memo.attachments')
    ?.map((item, index) => parseAttachment(item, index))
  const reactions = optionalArrayAt(root, 'reactions', 'memo.reactions')
    ?.map((item, index) => parseReaction(item, index))

  return {
    uid,
    creator,
    createTime,
    updateTime,
    state,
    visibility,
    pinned,
    contentPath,
    ...(tags !== undefined ? { tags } : {}),
    ...(location !== undefined ? { location } : {}),
    ...(space !== undefined ? { space } : {}),
    ...(parent !== undefined ? { parent } : {}),
    ...(relations !== undefined ? { relations } : {}),
    ...(attachments !== undefined ? { attachments } : {}),
    ...(reactions !== undefined ? { reactions } : {}),
  }
}

function parseCounts(value: unknown): MemoExportCounts {
  const counts = recordAt(value, 'manifest.counts')
  const memos = counts.memos === undefined
    ? undefined
    : nonNegativeIntegerAt(counts, 'memos', 'manifest.counts.memos')
  const attachments = counts.attachments === undefined
    ? undefined
    : nonNegativeIntegerAt(counts, 'attachments', 'manifest.counts.attachments')
  return {
    ...(memos !== undefined ? { memos } : {}),
    ...(attachments !== undefined ? { attachments } : {}),
  }
}

function parseLocation(value: unknown): MemoExportLocation {
  const location = recordAt(value, 'memo.location')
  const placeholder = optionalStringAt(location, 'placeholder', 'memo.location.placeholder')
  const latitude = optionalNumberAt(location, 'latitude', 'memo.location.latitude')
  const longitude = optionalNumberAt(location, 'longitude', 'memo.location.longitude')
  if (latitude !== undefined && (latitude < -90 || latitude > 90)) {
    throw new MemoExportFormatError('Expected a latitude between -90 and 90', 'memo.location.latitude')
  }
  if (longitude !== undefined && (longitude < -180 || longitude > 180)) {
    throw new MemoExportFormatError('Expected a longitude between -180 and 180', 'memo.location.longitude')
  }
  return {
    ...(placeholder !== undefined ? { placeholder } : {}),
    ...(latitude !== undefined ? { latitude } : {}),
    ...(longitude !== undefined ? { longitude } : {}),
  }
}

function parseSpace(value: unknown): MemoExportSpace {
  const space = recordAt(value, 'memo.space')
  const uid = uidAt(space, 'uid', 'memo.space.uid')
  const title = optionalStringAt(space, 'title', 'memo.space.title')
  return { uid, ...(title !== undefined ? { title } : {}) }
}

function parseRelation(value: unknown, index: number): MemoExportRelation {
  const path = `memo.relations[${index}]`
  const relation = recordAt(value, path)
  const type = oneOfAt(relation, 'type', `${path}.type`, MEMO_EXPORT_RELATION_TYPES)
  const memo = uidAt(relation, 'memo', `${path}.memo`)
  return { type, memo }
}

function parseAttachment(value: unknown, index: number): MemoExportAttachment {
  const path = `memo.attachments[${index}]`
  const attachment = recordAt(value, path)
  const uid = uidAt(attachment, 'uid', `${path}.uid`)
  const filename = nonEmptyStringAt(attachment, 'filename', `${path}.filename`)
  const type = stringAt(attachment, 'type', `${path}.type`)
  if (!isMemoExportMediaType(type)) {
    throw new MemoExportFormatError('Expected an IANA media type', `${path}.type`)
  }
  const size = nonNegativeIntegerAt(attachment, 'size', `${path}.size`)
  const createTime = timestampAt(attachment, 'createTime', `${path}.createTime`)
  const entryPath = optionalStringAt(attachment, 'path', `${path}.path`)
  const externalLink = optionalStringAt(attachment, 'externalLink', `${path}.externalLink`)
  const sha256 = optionalStringAt(attachment, 'sha256', `${path}.sha256`)

  if (entryPath !== undefined) {
    if (!isMemoExportEntryPath(entryPath)) {
      throw new MemoExportFormatError('Expected a safe archive entry path', `${path}.path`)
    }
    if (externalLink !== undefined) {
      throw new MemoExportFormatError('Expected either path or externalLink, not both', path)
    }
    if (sha256 === undefined || !isMemoExportSha256(sha256)) {
      throw new MemoExportFormatError('Expected a lowercase SHA-256 digest', `${path}.sha256`)
    }
  } else {
    if (externalLink === undefined || !isAbsoluteUri(externalLink)) {
      throw new MemoExportFormatError('Expected an absolute externalLink URI', `${path}.externalLink`)
    }
    if (sha256 !== undefined) {
      throw new MemoExportFormatError('An external attachment cannot carry a digest', `${path}.sha256`)
    }
  }

  const mediaMetadata = attachment.mediaMetadata === undefined
    ? undefined
    : parseMediaMetadata(attachment.mediaMetadata, `${path}.mediaMetadata`)

  return {
    uid,
    filename,
    type,
    size,
    createTime,
    ...(sha256 !== undefined ? { sha256 } : {}),
    ...(entryPath !== undefined ? { path: entryPath } : {}),
    ...(externalLink !== undefined ? { externalLink } : {}),
    ...(mediaMetadata !== undefined ? { mediaMetadata } : {}),
  }
}

function parseMediaMetadata(value: unknown, path: string): MemoExportMediaMetadata {
  const metadata = recordAt(value, path)
  const width = metadata.width === undefined
    ? undefined
    : nonNegativeIntegerAt(metadata, 'width', `${path}.width`)
  const height = metadata.height === undefined
    ? undefined
    : nonNegativeIntegerAt(metadata, 'height', `${path}.height`)
  const photo = metadata.photo === undefined ? undefined : recordAt(metadata.photo, `${path}.photo`)
  const video = metadata.video === undefined ? undefined : recordAt(metadata.video, `${path}.video`)
  if (photo !== undefined && video !== undefined) {
    throw new MemoExportFormatError('Expected photo or video details, not both', path)
  }
  return {
    ...(width !== undefined ? { width } : {}),
    ...(height !== undefined ? { height } : {}),
    ...(photo !== undefined ? { photo } : {}),
    ...(video !== undefined ? { video } : {}),
  }
}

function parseReaction(value: unknown, index: number): MemoExportReaction {
  const path = `memo.reactions[${index}]`
  const reaction = recordAt(value, path)
  const reactionType = nonEmptyStringAt(reaction, 'reactionType', `${path}.reactionType`)
  const creator = nonEmptyStringAt(reaction, 'creator', `${path}.creator`)
  const createTime = reaction.createTime === undefined
    ? undefined
    : timestampAt(reaction, 'createTime', `${path}.createTime`)
  return {
    reactionType,
    creator,
    ...(createTime !== undefined ? { createTime } : {}),
  }
}

function recordAt(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new MemoExportFormatError('Expected an object', path)
  }
  return value as Record<string, unknown>
}

function arrayAt(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) throw new MemoExportFormatError('Expected an array', path)
  return value
}

function optionalArrayAt(
  record: Record<string, unknown>,
  key: string,
  path: string,
): unknown[] | undefined {
  return record[key] === undefined ? undefined : arrayAt(record[key], path)
}

function stringAt(record: Record<string, unknown>, key: string, path: string): string {
  const value = record[key]
  if (typeof value !== 'string') throw new MemoExportFormatError('Expected a string', path)
  return value
}

function nonEmptyStringAt(record: Record<string, unknown>, key: string, path: string): string {
  return nonEmptyStringValue(record[key], path)
}

function nonEmptyStringValue(value: unknown, path: string): string {
  if (typeof value !== 'string' || !value) {
    throw new MemoExportFormatError('Expected a non-empty string', path)
  }
  return value
}

function optionalStringAt(
  record: Record<string, unknown>,
  key: string,
  path: string,
): string | undefined {
  return record[key] === undefined ? undefined : stringAt(record, key, path)
}

function booleanAt(record: Record<string, unknown>, key: string, path: string): boolean {
  const value = record[key]
  if (typeof value !== 'boolean') throw new MemoExportFormatError('Expected a boolean', path)
  return value
}

function optionalNumberAt(
  record: Record<string, unknown>,
  key: string,
  path: string,
): number | undefined {
  const value = record[key]
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new MemoExportFormatError('Expected a finite number', path)
  }
  return value
}

function nonNegativeIntegerAt(record: Record<string, unknown>, key: string, path: string): number {
  const value = record[key]
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new MemoExportFormatError('Expected a non-negative integer', path)
  }
  return value
}

function timestampAt(record: Record<string, unknown>, key: string, path: string): string {
  const value = stringAt(record, key, path)
  if (!isMemoExportTimestamp(value)) {
    throw new MemoExportFormatError('Expected an RFC 3339 UTC timestamp', path)
  }
  return value
}

function uidAt(record: Record<string, unknown>, key: string, path: string): string {
  return uidValue(record[key], path)
}

function uidValue(value: unknown, path: string): string {
  if (!isMemoExportUid(value)) throw new MemoExportFormatError('Expected a valid UID', path)
  return value
}

function entryPathAt(record: Record<string, unknown>, key: string, path: string): string {
  const value = stringAt(record, key, path)
  if (!isMemoExportEntryPath(value)) {
    throw new MemoExportFormatError('Expected a safe archive entry path', path)
  }
  return value
}

function oneOfAt<T extends string>(
  record: Record<string, unknown>,
  key: string,
  path: string,
  allowed: readonly T[],
): T {
  const value = stringAt(record, key, path)
  const match = allowed.find((candidate) => candidate === value)
  if (match === undefined) {
    throw new MemoExportFormatError(`Expected one of ${allowed.join(', ')}`, path)
  }
  return match
}

function isAbsoluteUri(value: string): boolean {
  try {
    return Boolean(new URL(value).protocol)
  } catch {
    return false
  }
}
