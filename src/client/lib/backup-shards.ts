import { completeManifestHash, parseMarkdownBackupManifest } from '@shared/backup-format'
import { LIMITS } from '@shared/constants'
import type { ImportResult } from '@shared/types'
import { readZip } from '@shared/zip'
import { restoreMarkdownBackupFolder } from './backup-import'

export const BACKUP_SHARD_INDEX_NAME = 'shards.json'
export const BACKUP_SHARD_INDEX_FORMAT = 'inkstone-backup-shards'

export interface BackupShardIndexEntry {
  file: string
  notes: number
  attachments: number
  bytes: number
}

export interface BackupShardIndex {
  format: typeof BACKUP_SHARD_INDEX_FORMAT
  version: 1
  snapshot: string
  complete: boolean
  shards: BackupShardIndexEntry[]
}

type SendBatch = Parameters<typeof restoreMarkdownBackupFolder>[1]

export interface BackupShardPage {
  blob: Blob
  snapshot: string
  nextAfterId: string | null
  noteCount: number
  attachmentCount: number
}

export async function collectBackupShards(
  load: (afterId: string, snapshot: string) => Promise<BackupShardPage>,
  writeFile: (name: string, blob: Blob) => Promise<void>,
  writeIndex: (index: BackupShardIndex) => Promise<void>,
): Promise<BackupShardIndex> {
  let afterId = ''
  let snapshot = ''
  const shards: BackupShardIndexEntry[] = []
  for (let count = 0; count < 1000; count++) {
    const page = await load(afterId, snapshot)
    if (!snapshot) snapshot = page.snapshot
    else if (page.snapshot !== snapshot) throw new Error('The backup snapshot changed between shards')
    const file = `inkstone-backup-${snapshot}-${String(shards.length + 1).padStart(3, '0')}.zip`
    await writeFile(file, page.blob)
    shards.push({ file, notes: page.noteCount, attachments: page.attachmentCount, bytes: page.blob.size })
    const index: BackupShardIndex = {
      format: BACKUP_SHARD_INDEX_FORMAT,
      version: 1,
      snapshot,
      complete: page.nextAfterId === null,
      shards,
    }
    await writeIndex(index)
    if (page.nextAfterId === null) return index
    if (page.nextAfterId === afterId) throw new Error('The backup cursor did not advance')
    afterId = page.nextAfterId
  }
  throw new Error('The backup exceeds the maximum number of shards')
}

export async function saveBackupShardsToDirectory(
  load: (afterId: string, snapshot: string) => Promise<BackupShardPage>,
  chooseDirectory: () => Promise<FileSystemDirectoryHandle>,
): Promise<BackupShardIndex> {
  const root = await chooseDirectory()
  let directory: FileSystemDirectoryHandle | null = null
  const ensureDirectory = async (snapshot: string) => {
    directory ??= await root.getDirectoryHandle(`inkstone-backup-${snapshot}`, { create: true })
    return directory
  }
  const writeBlob = async (target: FileSystemDirectoryHandle, name: string, blob: Blob) => {
    const handle = await target.getFileHandle(name, { create: true })
    const writable = await handle.createWritable()
    await writable.write(blob)
    await writable.close()
  }
  return collectBackupShards(
    async (afterId, snapshot) => {
      const page = await load(afterId, snapshot)
      await ensureDirectory(page.snapshot)
      return page
    },
    async (name, blob) => {
      if (!directory) throw new Error('The backup directory is unavailable')
      await writeBlob(directory, name, blob)
    },
    async (index) => {
      const target = await ensureDirectory(index.snapshot)
      await writeBlob(target, BACKUP_SHARD_INDEX_NAME, new Blob([JSON.stringify(index)], { type: 'application/json' }))
    },
  )
}

export function parseBackupShardIndex(value: unknown): BackupShardIndex | null {
  if (!isRecord(value) || value.format !== BACKUP_SHARD_INDEX_FORMAT || value.version !== 1) return null
  if (typeof value.snapshot !== 'string' || !/^\d{8}-\d{6}-\d{3}$/.test(value.snapshot)) return null
  if (value.complete !== true || !Array.isArray(value.shards) || !value.shards.length || value.shards.length > 1000) return null
  const names = new Set<string>()
  const shards: BackupShardIndexEntry[] = []
  for (const raw of value.shards) {
    if (!isRecord(raw) || typeof raw.file !== 'string') return null
    const file = raw.file
    if (
      !/^[^/\\]{1,180}\.zip$/.test(file) ||
      names.has(file.toLowerCase()) ||
      !isCount(raw.notes) ||
      !isCount(raw.attachments) ||
      !isCount(raw.bytes) ||
      raw.bytes === 0 ||
      raw.bytes > LIMITS.importUploadMaxBytes
    ) return null
    names.add(file.toLowerCase())
    shards.push({ file, notes: raw.notes, attachments: raw.attachments, bytes: raw.bytes })
  }
  return { format: BACKUP_SHARD_INDEX_FORMAT, version: 1, snapshot: value.snapshot, complete: true, shards }
}

export async function restoreShardedBackupFiles(
  files: readonly File[],
  send: SendBatch,
): Promise<ImportResult> {
  const byName = new Map(files.map((file) => [file.name.toLowerCase(), file]))
  const indexFile = byName.get(BACKUP_SHARD_INDEX_NAME)
  if (!indexFile) throw new Error('The sharded backup index is missing')
  let rawIndex: unknown
  try {
    rawIndex = JSON.parse(await indexFile.text())
  } catch {
    throw new Error('The sharded backup index is invalid')
  }
  const index = parseBackupShardIndex(rawIndex)
  if (!index) throw new Error('The sharded backup index is invalid or incomplete')

  const result = emptyResult()
  const noteIds = new Set<string>()
  const attachments = new Map<string, { path: string, filename: string, mime: string, size: number, createdAt: number }>()
  const libraries = new Set<string>()
  let appVersion: string | null = null

  for (const shard of index.shards) {
    const file = byName.get(shard.file.toLowerCase())
    if (!file) throw new Error(`The backup shard is missing: ${shard.file}`)
    if (file.size !== shard.bytes) throw new Error(`The backup shard size does not match: ${shard.file}`)
    const entries = await readZip(new Uint8Array(await file.arrayBuffer()), {
      maxEntries: LIMITS.importArchiveEntriesMax,
      maxEntryBytes: LIMITS.importArchiveExpandedMaxBytes,
      maxTotalBytes: LIMITS.importArchiveExpandedMaxBytes,
    })
    const entryByPath = new Map(entries.map((entry) => [entry.path.toLowerCase(), entry]))
    const manifestEntry = entryByPath.get('manifest.json')
    const completeEntry = entryByPath.get('complete')
    if (!manifestEntry || !completeEntry) throw new Error(`The backup shard is incomplete: ${shard.file}`)
    const decoder = new TextDecoder('utf-8', { fatal: true })
    let manifestRaw: unknown
    try {
      manifestRaw = JSON.parse(decoder.decode(manifestEntry.data))
    } catch {
      throw new Error(`The backup shard manifest is invalid: ${shard.file}`)
    }
    const manifest = parseMarkdownBackupManifest(manifestRaw)
    if (!manifest || manifest.snapshot !== index.snapshot) {
      throw new Error(`The backup shard manifest is invalid: ${shard.file}`)
    }
    const declaredHash = completeManifestHash(decoder.decode(completeEntry.data))
    if (!declaredHash || declaredHash !== await sha256Bytes(manifestEntry.data)) {
      throw new Error(`The backup shard completion marker is invalid: ${shard.file}`)
    }
    if (manifest.notes.length !== shard.notes || manifest.attachments.length !== shard.attachments) {
      throw new Error(`The backup shard index does not match its manifest: ${shard.file}`)
    }
    if (appVersion === null) appVersion = manifest.appVersion
    else if (appVersion !== manifest.appVersion) throw new Error('The backup shards were produced by different app versions')

    for (const note of manifest.notes) {
      if (noteIds.has(note.id)) throw new Error(`The backup contains a duplicate note: ${note.id}`)
      noteIds.add(note.id)
    }
    for (const attachment of manifest.attachments) {
      const previous = attachments.get(attachment.sha256)
      const metadata = { path: attachment.path, filename: attachment.filename, mime: attachment.mime, size: attachment.size, createdAt: attachment.createdAt }
      if (previous && JSON.stringify(previous) !== JSON.stringify(metadata)) {
        throw new Error(`The backup contains conflicting attachment metadata: ${attachment.sha256}`)
      }
      attachments.set(attachment.sha256, metadata)
    }
    for (const [kind, library] of [
      ['templates', manifest.templates],
      ['automation', manifest.automation],
      ['subscriptions', manifest.subscriptions],
      ['rss', manifest.rss],
      ['todos', manifest.todos],
      ['music', manifest.music],
      ['calendar', manifest.calendar],
      ['email', manifest.email],
      ['inknote', manifest.inknote],
    ] as const) {
      if (!library) continue
      if (libraries.has(kind)) throw new Error(`The backup contains a duplicate library: ${library.path}`)
      libraries.add(kind)
    }

    const shardFiles = entries.map((entry) => fileWithPath(
      new File([entry.data.slice().buffer], entry.path.slice(entry.path.lastIndexOf('/') + 1)),
      entry.path,
    ))
    mergeResult(result, await restoreMarkdownBackupFolder(shardFiles, send))
  }
  return result
}

function emptyResult(): ImportResult {
  return {
    createdNotes: 0,
    updatedNotes: 0,
    skippedNotes: 0,
    createdFolders: 0,
    createdAttachments: 0,
    skippedAttachments: 0,
    warnings: [],
  }
}

function mergeResult(target: ImportResult, next: ImportResult): void {
  target.createdNotes += next.createdNotes
  target.updatedNotes += next.updatedNotes
  target.skippedNotes += next.skippedNotes
  target.createdFolders += next.createdFolders
  target.createdAttachments += next.createdAttachments
  target.skippedAttachments += next.skippedAttachments
  target.emailAccounts = (target.emailAccounts ?? 0) + (next.emailAccounts ?? 0)
  target.emailMessages = (target.emailMessages ?? 0) + (next.emailMessages ?? 0)
  target.emailCreatedMessages = (target.emailCreatedMessages ?? 0) + (next.emailCreatedMessages ?? 0)
  target.emailSkippedMessages = (target.emailSkippedMessages ?? 0) + (next.emailSkippedMessages ?? 0)
  target.emailAttachments = (target.emailAttachments ?? 0) + (next.emailAttachments ?? 0)
  target.emailMissingAttachments = (target.emailMissingAttachments ?? 0) + (next.emailMissingAttachments ?? 0)
  for (const warning of next.warnings) {
    if (target.warnings.length >= 100) break
    target.warnings.push(warning)
  }
}

function fileWithPath(file: File, path: string): File {
  Object.defineProperty(file, 'webkitRelativePath', { value: path, configurable: true })
  return file
}

async function sha256Bytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes.slice().buffer)
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('')
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
