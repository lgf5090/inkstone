import { makeZip, predictLength } from 'client-zip'
import {
  assertArchiveSizesCanBeRestored,
  type BackupFile,
  type Snapshot,
} from './snapshot'

export interface BackupArchive {
  filename: string
  byteLength: bigint
  byteLengthNumber: number
  stream: ReadableStream<Uint8Array>
}

export function backupArchiveFilename(snapshot: Pick<Snapshot, 'stamp'>): string {
  return `inkstone-backup-${snapshot.stamp}.zip`
}

export function backupArchivePath(snapshot: Pick<Snapshot, 'stamp'>): string {
  return `backups/${backupArchiveFilename(snapshot)}`
}

export function createBackupArchive(snapshot: Snapshot): BackupArchive {
  const files = snapshotFiles(snapshot)
  // The restore limits are the real ceiling: a ZIP that can never be imported back is
  // not a backup, and building it would buffer hundreds of MB in this isolate.
  assertArchiveSizesCanBeRestored(files.map((file) => ({ path: file.path, byteLength: file.byteLength })))
  const byteLength = predictLength(metadataFromFiles(files, snapshot.createdAt))
  const byteLengthNumber = Number(byteLength)
  if (!Number.isSafeInteger(byteLengthNumber) || byteLengthNumber < 0) {
    throw new Error('The backup ZIP is too large to transfer safely')
  }

  return {
    filename: backupArchiveFilename(snapshot),
    byteLength,
    byteLengthNumber,
    stream: cancellationSafeStream(makeZip(openFiles(files, snapshot.createdAt), {
      length: byteLength,
      buffersAreUTF8: true,
    })),
  }
}

function snapshotFiles(snapshot: Snapshot): BackupFile[] {
  return [...snapshot.payloadFiles, snapshot.manifestFile, snapshot.completeFile]
}

function metadataFromFiles(files: readonly BackupFile[], lastModified: Date) {
  return files.map((file) => ({
    name: file.path,
    size: file.byteLength,
    lastModified,
    mode: 0o644,
  }))
}

/** Files whose consistency re-read is in flight while the ZIP consumes the current one. */
const OPEN_PREFETCH = 8

async function* openFiles(files: readonly BackupFile[], lastModified: Date) {
  // Each file is still re-read at the moment its entry is produced (that is the consistency
  // guarantee), but the re-reads are now pipelined: waiting one D1 round trip per note made a
  // 5000 note backup spend 40–75 s purely waiting between entries.
  const pending: Array<{ file: BackupFile, input: Promise<ReadableStream<Uint8Array>> }> = []
  let next = 0
  const fill = () => {
    while (pending.length < OPEN_PREFETCH && next < files.length) {
      const file = files[next++]!
      pending.push({ file, input: (async () => exactSizeStream(await file.open(), file))() })
    }
  }
  try {
    fill()
    while (pending.length) {
      const { file, input } = pending.shift()!
      yield {
        name: file.path,
        size: file.byteLength,
        lastModified,
        mode: 0o644,
        input: await input,
      }
      fill()
    }
  } finally {
    // A cancelled consumer must not leave the in-flight re-reads as unhandled rejections.
    for (const entry of pending) entry.input.catch(() => {})
  }
}

function exactSizeStream(
  source: ReadableStream<Uint8Array>,
  file: Pick<BackupFile, 'path' | 'byteLength'>,
): ReadableStream<Uint8Array> {
  let bytes = 0
  return source.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      bytes += chunk.byteLength
      if (bytes > file.byteLength) throw new Error(`Backup source size changed: ${file.path}`)
      controller.enqueue(chunk)
    },
    flush() {
      if (bytes !== file.byteLength) throw new Error(`Backup source size changed: ${file.path}`)
    },
  }))
}

function cancellationSafeStream(source: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const reader = source.getReader()
  let pending: Promise<ReadableStreamReadResult<Uint8Array>> | null = null
  let cancelled = false
  let released = false
  const release = () => {
    if (released) return
    released = true
    reader.releaseLock()
  }

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        pending = reader.read()
        const result = await pending
        pending = null
        if (cancelled) {
          release()
          return
        }
        if (result.done) {
          release()
          controller.close()
        } else {
          controller.enqueue(result.value)
        }
      } catch (error) {
        pending = null
        release()
        controller.error(error)
      }
    },
    async cancel() {
      cancelled = true
      if (pending) await pending.catch(() => {})
      release()
    },
  })
}
