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
    // Emitting the declared length is what lets a test consume the archive to completion:
    // the size guard in archive.ts rejects a short re-read.
    open: async () => new ReadableStream<Uint8Array>({
      start(controller) {
        if (byteLength) controller.enqueue(new Uint8Array(byteLength))
        controller.close()
      },
    }),
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

  it('pipelines the per-file re-reads, bounded, and keeps entry order', async () => {
    const started: number[] = []
    let inFlight = 0
    let maxInFlight = 0
    const payloadFiles = Array.from({ length: 30 }, (_, index) => {
      const entry = file(`notes/n-${String(index).padStart(2, '0')}.md`, 8)
      return {
        ...entry,
        open: async (): Promise<ReadableStream<Uint8Array>> => {
          started.push(index)
          inFlight += 1
          maxInFlight = Math.max(maxInFlight, inFlight)
          await new Promise((resolve) => setTimeout(resolve, (index % 5) * 2))
          inFlight -= 1
          return await entry.open()
        },
      }
    })
    const archive = createBackupArchive(snapshot(payloadFiles))
    const reader = archive.stream.getReader()
    const chunks: Uint8Array[] = []
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value!)
    }
    const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)
    const merged = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) {
      merged.set(chunk, offset)
      offset += chunk.byteLength
    }
    const asText = new TextDecoder('latin1').decode(merged)
    const positions = payloadFiles.map((entry) => asText.indexOf(entry.path))
    expect(positions.every((position) => position >= 0)).toBe(true)
    expect([...positions].sort((a, b) => a - b)).toEqual(positions)
    expect(started.sort((a, b) => a - b)).toEqual(payloadFiles.map((_, index) => index))
    expect(maxInFlight).toBeGreaterThan(1)
    expect(maxInFlight).toBeLessThanOrEqual(8)
  })

  it('surfaces a re-read failure instead of shipping a short archive', async () => {
    const broken = file('notes/broken.md', 8)
    const archive = createBackupArchive(snapshot([
      broken,
      { ...broken, path: 'notes/b2.md', open: async () => { throw new Error('D1 went away') } },
    ]))
    const reader = archive.stream.getReader()
    await expect((async () => {
      for (;;) {
        const { done } = await reader.read()
        if (done) break
      }
    })()).rejects.toThrow(/D1 went away/i)
  })
})
