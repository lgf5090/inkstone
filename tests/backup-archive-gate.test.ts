import { describe, expect, it } from 'vitest'
import { createBackupArchive } from '../src/worker/backup/archive'
import type { BackupFile, Snapshot } from '../src/worker/backup/snapshot'
import { LIMITS } from '@shared/constants'

const MEBIBYTE = 1024 * 1024

function file(path: string, byteLength: number): BackupFile {
  return {
    path,
    byteLength,
    sha256: '0000000000000000000000000000000000000000000000000000000000000000',
    contentType: 'text/markdown',
    kind: 'note' as BackupFile['kind'],
    open: async () => new ReadableStream<Uint8Array>(),
  }
}

function snapshot(payloadFiles: BackupFile[]): Snapshot {
  return {
    payloadFiles,
    manifestFile: file('manifest.json', 64),
    completeFile: file('complete.json', 16),
    noteCount: payloadFiles.length,
    attachmentCount: 0,
    bytes: payloadFiles.reduce((sum, entry) => sum + entry.byteLength, 0),
    stamp: '20261005-000000',
    createdAt: new Date(0),
  }
}

describe('createBackupArchive', () => {
  it('builds an archive for a snapshot inside the restore limits', () => {
    const archive = createBackupArchive(snapshot([file('notes/a.md', 2 * MEBIBYTE)]))
    expect(archive.byteLength > 0n).toBe(true)
    expect(archive.filename).toContain('20261005-000000')
  })

  it('refuses a snapshot whose expanded size cannot be restored', () => {
    const oversized = Array.from({ length: 4 }, (_, index) => file(`notes/big-${index}.md`, 30 * MEBIBYTE))
    expect(() => createBackupArchive(snapshot(oversized)))
      .toThrow(new RegExp(`folder restore|restore limit`, 'i'))
  })

  it('refuses more entries than the importer accepts', () => {
    const many = Array.from(
      { length: LIMITS.importArchiveEntriesMax + 1 },
      (_, index) => file(`notes/note-${index}.md`, 16),
    )
    expect(() => createBackupArchive(snapshot(many))).toThrow(/exceeding the restore limit/i)
  })
})
