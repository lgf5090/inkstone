import {
  backupCompletePath,
  backupEmailAttachmentPath,
  backupManifestPath,
  completeManifestHash,
  MARKDOWN_BACKUP_FORMAT,
  parseMarkdownBackupManifest,
  type MarkdownBackupAttachmentEntry,
  type MarkdownBackupManifest,
  type MarkdownBackupNoteEntry,
} from '@shared/backup-format'
import { parseEmailBackupBundle } from '@shared/email/backup'
import { LIMITS } from '@shared/constants'
import type { ImportResult } from '@shared/types'
import { t } from './i18n'

interface SelectedBackupFile<T extends MarkdownBackupAttachmentEntry | MarkdownBackupNoteEntry> {
  file: File
  path: string
  entry: T
}

interface SelectedEmailAttachment {
  file: File
  path: string
  bytes: number
  sha256?: string
}

interface BackupSelection {
  manifest: MarkdownBackupManifest
  attachments: SelectedBackupFile<MarkdownBackupAttachmentEntry>[]
  notes: SelectedBackupFile<MarkdownBackupNoteEntry>[]
  templates: { file: File; path: string } | null
  automation: { file: File; path: string } | null
  music: { file: File; path: string } | null
  email: { file: File; path: string } | null
  emailAttachments: SelectedEmailAttachment[]
  warning: string | null
}

type SendBatch = (
  files: File[],
  manifest: MarkdownBackupManifest,
  paths: string[],
) => Promise<ImportResult>

const NOTE_BATCH_BYTES = 8 * 1024 * 1024
const NOTE_BATCH_FILES = 50
const ATTACHMENT_BATCH_FILES = 20

export async function restoreMarkdownBackupFolder(
  files: readonly File[],
  send: SendBatch,
): Promise<ImportResult> {
  const selection = await selectLatestCompleteBackup(files)
  const result = emptyResult()
  const attachmentEntryByHash = new Map(
    selection.manifest.attachments.map((entry) => [entry.sha256, entry]),
  )
  if (selection.warning) result.warnings.push(selection.warning)

  for (const selected of selection.attachments) await verifySelectedFile(selected)
  for (const selected of selection.notes) await verifySelectedFile(selected)
  if (selection.templates) {
    const { file, path } = selection.templates
    if (file.size !== selection.manifest.templates!.bytes) throw new Error(t('settings.backup_file_size_mismatch', { value0: path }))
    if (await sha256File(file) !== selection.manifest.templates!.sha256) throw new Error(t('settings.backup_file_checksum_failed', { value0: path }))
  }
  if (selection.automation) {
    const { file, path } = selection.automation
    if (file.size !== selection.manifest.automation!.bytes) throw new Error(t('settings.backup_file_size_mismatch', { value0: path }))
    if (await sha256File(file) !== selection.manifest.automation!.sha256) throw new Error(t('settings.backup_file_checksum_failed', { value0: path }))
  }
  if (selection.music) {
    const { file, path } = selection.music
    if (file.size !== selection.manifest.music!.bytes) throw new Error(t('settings.backup_file_size_mismatch', { value0: path }))
    if (await sha256File(file) !== selection.manifest.music!.sha256) throw new Error(t('settings.backup_file_checksum_failed', { value0: path }))
  }
  if (selection.email) {
    const { file, path } = selection.email
    if (file.size !== selection.manifest.email!.bytes) throw new Error(t('settings.backup_file_size_mismatch', { value0: path }))
    if (await sha256File(file) !== selection.manifest.email!.sha256) throw new Error(t('settings.backup_file_checksum_failed', { value0: path }))
  }
  for (const selected of selection.emailAttachments) {
    if (selected.file.size !== selected.bytes) throw new Error(t('settings.backup_file_size_mismatch', { value0: selected.path }))
    if (selected.sha256 && await sha256File(selected.file) !== selected.sha256) {
      throw new Error(t('settings.backup_file_checksum_failed', { value0: selected.path }))
    }
  }

  let attachmentBatch: SelectedBackupFile<MarkdownBackupAttachmentEntry>[] = []
  let attachmentBatchBytes = 0
  const flushAttachments = async () => {
    if (!attachmentBatch.length) return
    mergeResult(
      result,
      await send(
        attachmentBatch.map((selected) => selected.file),
        manifestSlice(
          selection.manifest,
          [],
          attachmentBatch.map((selected) => selected.entry),
        ),
        attachmentBatch.map((selected) => selected.path),
      ),
    )
    attachmentBatch = []
    attachmentBatchBytes = 0
  }
  for (const selected of selection.attachments) {
    if (
      attachmentBatch.length &&
      (
        attachmentBatch.length >= ATTACHMENT_BATCH_FILES ||
        attachmentBatchBytes + selected.file.size > LIMITS.attachmentMaxBytes
      )
    ) {
      await flushAttachments()
    }
    attachmentBatch.push(selected)
    attachmentBatchBytes += selected.file.size
  }
  await flushAttachments()

  let batch: SelectedBackupFile<MarkdownBackupNoteEntry>[] = []
  let batchBytes = 0
  const flush = async () => {
    if (!batch.length) return
    const dependencyHashes = new Set(
      batch.flatMap((selected) => selected.entry.attachmentHashes),
    )
    const dependencies = [...dependencyHashes].map((hash) => attachmentEntryByHash.get(hash)!)
    mergeResult(
      result,
      await send(
        batch.map((selected) => selected.file),
        manifestSlice(selection.manifest, batch.map((selected) => selected.entry), dependencies),
        batch.map((selected) => selected.path),
      ),
    )
    batch = []
    batchBytes = 0
  }
  for (const selected of selection.notes) {
    if (
      batch.length &&
      (batch.length >= NOTE_BATCH_FILES || batchBytes + selected.file.size > NOTE_BATCH_BYTES)
    ) {
      await flush()
    }
    batch.push(selected)
    batchBytes += selected.file.size
  }
  await flush()
  if (selection.templates) {
    mergeResult(
      result,
      await send(
        [selection.templates.file],
        manifestSlice(selection.manifest, [], []),
        [selection.templates.path],
      ),
    )
  }
  if (selection.automation) {
    mergeResult(
      result,
      await send(
        [selection.automation.file],
        manifestSlice(selection.manifest, [], []),
        [selection.automation.path],
      ),
    )
  }
  if (selection.music) {
    mergeResult(
      result,
      await send(
        [selection.music.file],
        manifestSlice(selection.manifest, [], []),
        [selection.music.path],
      ),
    )
  }
  if (selection.email) {
    mergeResult(
      result,
      await send(
        [selection.email.file, ...selection.emailAttachments.map((selected) => selected.file)],
        manifestSlice(selection.manifest, [], []),
        [selection.email.path, ...selection.emailAttachments.map((selected) => selected.path)],
      ),
    )
  }
  return result
}

async function selectLatestCompleteBackup(files: readonly File[]): Promise<BackupSelection> {
  const byPath = new Map<string, File>()
  for (const file of files) {
    const path = selectedPath(file)
    const key = path.toLowerCase()
    if (byPath.has(key)) throw new Error(t('settings.backup_duplicate_path', { value0: path }))
    byPath.set(key, file)
  }

  const candidates: Array<{
    file: File
    path: string
    manifest: MarkdownBackupManifest
    rootPrefix: string
    complete: File | undefined
  }> = []
  let manifestSeen = false
  for (const file of byPath.values()) {
    const path = selectedPath(file)
    if (!/(?:^|\/)manifest\.json$/i.test(path)) continue
    const legacyPath = /(?:^|\/)snapshots\/\d{8}-\d{6}-\d{3}\/manifest\.json$/i.test(path)
    const directory = path.slice(0, path.lastIndexOf('/') + 1)
    const siblingComplete = byPath.get(`${directory}complete`.toLowerCase())
    if (file.size > LIMITS.importUploadMaxBytes) {
      if (legacyPath || siblingComplete) {
        throw new Error(t('settings.backup_manifest_invalid', { value0: path }))
      }
      continue
    }
    let raw: unknown
    try {
      raw = JSON.parse(await file.text())
    } catch {
      if (legacyPath || siblingComplete) manifestSeen = true
      if (siblingComplete) throw new Error(t('settings.backup_manifest_invalid', { value0: path }))
      continue
    }
    const declaresInkstone = isRecord(raw) && raw.format === MARKDOWN_BACKUP_FORMAT
    if (legacyPath || declaresInkstone) manifestSeen = true
    const manifest = parseMarkdownBackupManifest(raw)
    if (!manifest) {
      if (siblingComplete && declaresInkstone) {
        throw new Error(t('settings.backup_manifest_invalid', { value0: path }))
      }
      continue
    }
    const suffix = backupManifestPath(manifest.snapshot, manifest.version)
    if (!path.toLowerCase().endsWith(suffix.toLowerCase())) {
      if (siblingComplete) throw new Error(t('settings.backup_manifest_invalid', { value0: path }))
      continue
    }
    const rootPrefix = path.slice(0, path.length - suffix.length)
    const complete = byPath.get(
      `${rootPrefix}${backupCompletePath(manifest.snapshot, manifest.version)}`.toLowerCase(),
    )
    if (complete && complete.size > 1024) {
      throw new Error(t('settings.backup_complete_marker_mismatch', { value0: path }))
    }
    candidates.push({ file, path, manifest, rootPrefix, complete })
  }
  candidates.sort((a, b) => b.manifest.snapshot.localeCompare(a.manifest.snapshot))

  const skipped: string[] = []
  for (const candidate of candidates) {
    const { manifest, rootPrefix, complete } = candidate
    if (!complete) {
      skipped.push(manifest.snapshot)
      continue
    }
    const declaredHash = completeManifestHash(await complete.text())
    const actualHash = await sha256File(candidate.file)
    if (!declaredHash || declaredHash !== actualHash) {
      throw new Error(t('settings.backup_complete_marker_mismatch', { value0: candidate.path }))
    }
    const resolve = <T extends MarkdownBackupAttachmentEntry | MarkdownBackupNoteEntry>(
      entry: T,
    ): SelectedBackupFile<T> => {
      const path = entry.path
      const file = byPath.get(`${rootPrefix}${path}`.toLowerCase())
      if (!file) throw new Error(t('settings.backup_missing_file', { value0: path }))
      return { file, path, entry }
    }
    const resolveLibrary = (entry: { path: string } | undefined) => {
      if (!entry) return null
      const path = entry.path
      const file = byPath.get(`${rootPrefix}${path}`.toLowerCase())
      if (!file) throw new Error(t('settings.backup_missing_file', { value0: path }))
      return { file, path }
    }
    const email = resolveLibrary(manifest.email)
    const emailAttachments = email && manifest.email
      ? await selectEmailAttachments(email, manifest, manifest.email.includesAttachments, rootPrefix, byPath)
      : []
    return {
      manifest,
      attachments: manifest.attachments.map(resolve),
      notes: manifest.notes.map(resolve),
      templates: resolveLibrary(manifest.templates),
      automation: resolveLibrary(manifest.automation),
      music: resolveLibrary(manifest.music),
      email,
      emailAttachments,
      warning: skipped.length
        ? t('settings.backup_newer_snapshot_skipped', { value0: skipped[0] })
        : null,
    }
  }

  throw new Error(
    manifestSeen
      ? t('settings.backup_no_complete_snapshot')
      : t('settings.backup_manifest_not_found'),
  )
}

async function selectEmailAttachments(
  email: { file: File; path: string },
  manifest: MarkdownBackupManifest,
  includesAttachments: boolean,
  rootPrefix: string,
  byPath: Map<string, File>,
): Promise<SelectedEmailAttachment[]> {
  if (!includesAttachments) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(await email.file.text())
  } catch {
    throw new Error(t('settings.backup_manifest_invalid', { value0: email.path }))
  }
  const bundle = parseEmailBackupBundle(parsed)
  if (
    !bundle ||
    !manifest.email ||
    bundle.snapshot !== manifest.snapshot ||
    bundle.includesAttachments !== manifest.email.includesAttachments
  ) {
    throw new Error(t('settings.backup_manifest_invalid', { value0: email.path }))
  }
  const selected: SelectedEmailAttachment[] = []
  for (const account of bundle.accounts) {
    for (const message of account.messages) {
      for (const attachment of message.attachments) {
        if (attachment.missing) continue
        const path = backupEmailAttachmentPath(
          bundle.snapshot,
          account.id,
          message.id,
          attachment.id,
          attachment.filename,
        )
        const file = byPath.get(`${rootPrefix}${path}`.toLowerCase())
        if (!file) continue
        selected.push({
          file,
          path,
          bytes: attachment.size,
          ...(attachment.sha256 ? { sha256: attachment.sha256 } : {}),
        })
      }
    }
  }
  return selected
}

async function verifySelectedFile(
  selected: SelectedBackupFile<MarkdownBackupAttachmentEntry | MarkdownBackupNoteEntry>,
): Promise<void> {
  const expectedBytes = 'bytes' in selected.entry ? selected.entry.bytes : selected.entry.size
  if (selected.file.size !== expectedBytes) throw new Error(t('settings.backup_file_size_mismatch', { value0: selected.path }))
  if (await sha256File(selected.file) !== selected.entry.sha256) throw new Error(t('settings.backup_file_checksum_failed', { value0: selected.path }))
}

function manifestSlice(
  manifest: MarkdownBackupManifest,
  notes: MarkdownBackupNoteEntry[],
  attachments: MarkdownBackupAttachmentEntry[],
): MarkdownBackupManifest {
  return { ...manifest, notes, attachments }
}

async function sha256File(file: Blob): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer())
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('')
}

function selectedPath(file: File): string {
  return (file.webkitRelativePath || file.name).replace(/\\/g, '/').replace(/^\/+/, '')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
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
