import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MarkdownBackupManifest } from '../src/shared/backup-format'
import { MARKDOWN_BACKUP_FORMAT } from '@shared/backup-format'
import { restoreMarkdownBackupFolder } from '../src/client/lib/backup-import'
import type { ImportResult } from '../src/shared/types'

const STAMP = '20261007-090000-000'

function sha(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

// A `File` body has to sit on a non-shared buffer, so the bytes come in as `TextEncoder` made them.
function fileOf(path: string, bytes: Uint8Array<ArrayBuffer>): File {
  const file = new File([bytes], path)
  Object.defineProperty(file, 'webkitRelativePath', { value: path })
  return file
}

const noteBytes = new TextEncoder().encode('# Restored\n')
const templateBytes = new TextEncoder().encode(JSON.stringify({
  app: 'inkstone',
  kind: 'template-library',
  version: 1,
  exportedAt: 1,
  categories: [{ id: 'cat-1', name: 'Backup', builtin: false, position: 0, createdAt: 1, icon: '🧰', color: '#0891b2' }],
  templates: [{
    id: 'tpl-1',
    categoryId: 'cat-1',
    name: 'Restored',
    description: '',
    content: '# Body\n',
    tags: [],
    builtin: false,
    isPinned: true,
    isStarred: true,
    createdAt: 1,
    updatedAt: 1,
  }],
}))

const manifest: MarkdownBackupManifest = {
  format: MARKDOWN_BACKUP_FORMAT,
  version: 3,
  appVersion: '0.8.0',
  createdAt: new Date(1).toISOString(),
  snapshot: STAMP,
  notes: [{
    id: 'dz2yggnw3ne7wpzkmke800t6mv',
    path: 'notes/restored.md',
    title: 'Restored',
    folder: [],
    attachmentHashes: [],
    state: 'notes',
    archived: false,
    bytes: noteBytes.byteLength,
    sha256: sha(noteBytes),
    createdAt: 1,
    updatedAt: 1,
    deletedAt: null,
  }],
  attachments: [],
  templates: { path: 'templates.json', bytes: templateBytes.byteLength, sha256: sha(templateBytes) },
}

const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest))
const completeBytes = new TextEncoder().encode(
  `${MARKDOWN_BACKUP_FORMAT} v3\nmanifest-sha256 ${sha(manifestBytes)}\n`,
)

function backupFiles(): File[] {
  return [
    fileOf('manifest.json', manifestBytes),
    fileOf('COMPLETE', completeBytes),
    fileOf('notes/restored.md', noteBytes),
    fileOf('templates.json', templateBytes),
  ]
}

const emptyResult = (): ImportResult => ({
  createdNotes: 1,
  updatedNotes: 0,
  skippedNotes: 0,
  createdFolders: 0,
  createdAttachments: 0,
  skippedAttachments: 0,
  warnings: [],
})

let sends: Array<{ files: File[]; manifest: MarkdownBackupManifest; paths: string[] }> = []

beforeEach(() => {
  sends = []
  // `sha256File` only ever calls this with an `ArrayBuffer`, which is what `Blob.arrayBuffer()` gives.
  vi.stubGlobal('crypto', { subtle: { digest: async (_algo: AlgorithmIdentifier, data: ArrayBuffer) => new Uint8Array(createHash('sha256').update(new Uint8Array(data)).digest()) } })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

async function restore(files: File[] = backupFiles()) {
  return restoreMarkdownBackupFolder(files, async (batch, sentManifest, paths) => {
    sends.push({ files: batch, manifest: sentManifest, paths })
    return emptyResult()
  })
}

describe('restoring a locked note with encrypted attachments', () => {
  it('restores the locked note before sending ciphertext bytes', async () => {
    const title = 'memoenc:v1:MDEyMzQ1Njc4OWFiY2RlZg:AAECAwQFBgcICQoL:FMTWLJk0wmu0Cy1AXOh8hiCoNyjz2nFQrxkhwQ'
    const content = 'memoenc:v1:MDEyMzQ1Njc4OWFiY2RlZg:EBESExQVFhcYGRob:A2Za-kthB_yqNn99GgvTCLWWQ7IaSy89GcHy'
    const body = new TextEncoder().encode(content)
    const ciphertext = new Uint8Array(40)
    ciphertext.set([73, 75, 65, 49])
    const hash = sha(ciphertext)
    const noteId = '00000000000000000000000001'
    const lockedManifest: MarkdownBackupManifest = {
      format: MARKDOWN_BACKUP_FORMAT,
      version: 3,
      appVersion: '0.8.0',
      createdAt: new Date(1).toISOString(),
      snapshot: STAMP,
      notes: [{
        id: noteId,
        path: 'notes/locked.md',
        title,
        folder: [],
        attachmentHashes: [hash],
        state: 'notes',
        archived: false,
        isEncrypted: true,
        bytes: body.byteLength,
        sha256: sha(body),
        createdAt: 1,
        updatedAt: 1,
        deletedAt: null,
      }],
      attachments: [{
        path: `attachments/${hash}--secret.bin`,
        filename: 'secret.bin',
        mime: 'application/octet-stream',
        size: ciphertext.byteLength,
        sha256: hash,
        createdAt: 1,
        id: '00000000000000000000000002',
        noteId,
        encryption: 'note-lock-v1',
        plaintextSize: 8,
      }],
    }
    const manifestData = new TextEncoder().encode(JSON.stringify(lockedManifest))
    const complete = new TextEncoder().encode(`${MARKDOWN_BACKUP_FORMAT} v3\nmanifest-sha256 ${sha(manifestData)}\n`)
    await restore([
      fileOf('manifest.json', manifestData),
      fileOf('COMPLETE', complete),
      fileOf('notes/locked.md', body),
      fileOf(`attachments/${hash}--secret.bin`, ciphertext),
    ])
    expect(sends.map((sent) => sent.paths)).toEqual([
      ['notes/locked.md'],
      [`attachments/${hash}--secret.bin`],
    ])
    expect(sends[1]?.manifest.notes[0]?.id).toBe(noteId)
    expect(sends[1]?.manifest.attachments[0]?.encryption).toBe('note-lock-v1')
  })
})

describe('restoring a backup folder that carries a template library', () => {
  it('sends the library file in its own batch, named by its manifest path', async () => {
    await restore()
    const templatesBatch = sends.find((sent) => sent.paths.includes('templates.json'))
    expect(templatesBatch).toBeDefined()
    expect(templatesBatch!.files[0].name).toBe('templates.json')
    expect(templatesBatch!.manifest.templates).toEqual(manifest.templates)
    expect(templatesBatch!.manifest.notes).toEqual([])
  })

  it('still sends every note alongside it', async () => {
    await restore()
    expect(sends.some((sent) => sent.paths.includes('notes/restored.md'))).toBe(true)
    expect(sends.some((sent) => sent.paths.includes('templates.json'))).toBe(true)
  })

  it('refuses a library file whose checksum does not match the manifest', async () => {
    const files = backupFiles()
    const sameSize = new Uint8Array(templateBytes)
    sameSize[sameSize.length - 2] = sameSize[sameSize.length - 2] === 0x31 ? 0x32 : 0x31
    const tampered = fileOf('templates.json', sameSize)
    await expect(restore(files.map((file) => file.name === 'templates.json' ? tampered : file)))
      .rejects.toThrow(/backup_file_checksum_failed/)
    expect(sends).toEqual([])
  })

  it('refuses a library file that is not the size the manifest promised', async () => {
    const files = backupFiles()
    const tampered = fileOf('templates.json', new TextEncoder().encode('{"tampered":true}'))
    await expect(restore(files.map((file) => file.name === 'templates.json' ? tampered : file)))
      .rejects.toThrow(/backup_file_size_mismatch/)
    expect(sends).toEqual([])
  })

  it('sends subscription, todo, calendar and inknote libraries in their own batches', async () => {
    const libraries = [
      ['subscriptions', 'subscriptions.json'],
      ['todos', 'todos.json'],
      ['calendar', 'calendar.json'],
      ['inknote', 'inknote.json'],
    ] as const
    const bytes = new TextEncoder().encode('{}')
    const digest = sha(bytes)
    const withLibraries: MarkdownBackupManifest = {
      ...manifest,
      ...Object.fromEntries(libraries.map(([kind, path]) => [kind, { path, bytes: bytes.byteLength, sha256: digest }])),
    }
    const manifestData = new TextEncoder().encode(JSON.stringify(withLibraries))
    const complete = new TextEncoder().encode(`${MARKDOWN_BACKUP_FORMAT} v3\nmanifest-sha256 ${sha(manifestData)}\n`)
    await restore([
      fileOf('manifest.json', manifestData),
      fileOf('COMPLETE', complete),
      fileOf('notes/restored.md', noteBytes),
      fileOf('templates.json', templateBytes),
      ...libraries.map(([, path]) => fileOf(path, bytes)),
    ])
    for (const [, path] of libraries) {
      expect(sends.find((sent) => sent.paths.includes(path))?.files[0].name).toBe(path)
    }
  })

  it('restores a backup without a library file exactly as before', async () => {
    const withoutTemplates: MarkdownBackupManifest = { ...manifest, templates: undefined }
    const plainManifestBytes = new TextEncoder().encode(JSON.stringify(withoutTemplates))
    const plainComplete = new TextEncoder().encode(
      `${MARKDOWN_BACKUP_FORMAT} v3\nmanifest-sha256 ${sha(plainManifestBytes)}\n`,
    )
    await restore([
      fileOf('manifest.json', plainManifestBytes),
      fileOf('COMPLETE', plainComplete),
      fileOf('notes/restored.md', noteBytes),
    ])
    expect(sends).toHaveLength(1)
    expect(sends[0].paths).toEqual(['notes/restored.md'])
  })
})
