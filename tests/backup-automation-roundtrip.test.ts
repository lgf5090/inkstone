import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildSnapshot, materializeSnapshot } from '../src/worker/backup/snapshot'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import {
  BACKUP_AUTOMATION_NAME,
  MARKDOWN_BACKUP_FORMAT,
  parseMarkdownBackupManifest,
  type MarkdownBackupManifest,
} from '../src/shared/backup-format'
import { restoreMarkdownBackupFolder } from '../src/client/lib/backup-import'
import {
  buildQuickAddPayload,
  defaultQuickAddSettings,
  newCaptureChoice,
  parseQuickAddText,
  QUICKADD_VERSION,
} from '../src/shared/quickadd'
import { makeD1 } from './doubles/d1-sqlite'
import { newId } from '../src/worker/lib/id'
import type { ImportResult } from '../src/shared/types'

const STAMP = '20261008-090000-000'
const USER = 'user-1'

function sha(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function fileOf(path: string, bytes: Uint8Array): File {
  const file = new File([bytes], path)
  Object.defineProperty(file, 'webkitRelativePath', { value: path })
  return file
}

const noteBytes = new TextEncoder().encode('# Restored\n')
const automationBytes = new TextEncoder().encode(JSON.stringify(
  buildQuickAddPayload(defaultQuickAddSettings(), [newCaptureChoice('c1', 'Quick capture', 0)]),
))

function manifestWith(entry?: { path: string; bytes: number; sha256: string }): MarkdownBackupManifest {
  return {
    format: MARKDOWN_BACKUP_FORMAT,
    version: 4,
    appVersion: '0.9.0',
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
    automation: entry,
  }
}

const manifest = manifestWith({ path: BACKUP_AUTOMATION_NAME, bytes: automationBytes.byteLength, sha256: sha(automationBytes) })
const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest))
const completeBytes = new TextEncoder().encode(
  `${MARKDOWN_BACKUP_FORMAT} v4\nmanifest-sha256 ${sha(manifestBytes)}\n`,
)

function backupFiles(): File[] {
  return [
    fileOf('manifest.json', manifestBytes),
    fileOf('COMPLETE', completeBytes),
    fileOf('notes/restored.md', noteBytes),
    fileOf(BACKUP_AUTOMATION_NAME, automationBytes),
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
  vi.stubGlobal('crypto', { subtle: { digest: async (_algo, data) => new Uint8Array(sha256Bytes(data)) } })
})

function sha256Bytes(data: ArrayBuffer): Uint8Array {
  return new Uint8Array(createHash('sha256').update(new Uint8Array(data)).digest())
}

afterEach(() => {
  vi.unstubAllGlobals()
})

async function restore(files: File[] = backupFiles()) {
  return restoreMarkdownBackupFolder(files, async (batch, sentManifest, paths) => {
    sends.push({ files: batch, manifest: sentManifest, paths })
    return emptyResult()
  })
}

describe('restoring a backup folder that carries the automation library', () => {
  it('sends automation.json in its own batch, named by its manifest path', async () => {
    await restore()
    const batch = sends.find((sent) => sent.paths.includes(BACKUP_AUTOMATION_NAME))
    expect(batch, 'the library file needs its own batch so a note batch never swallows it').toBeDefined()
    expect(batch!.files[0].name).toBe(BACKUP_AUTOMATION_NAME)
    expect(batch!.manifest.automation).toEqual(manifest.automation)
    expect(batch!.manifest.notes).toEqual([])
  })

  it('still sends every note alongside it', async () => {
    await restore()
    expect(sends.some((sent) => sent.paths.includes('notes/restored.md'))).toBe(true)
    expect(sends.some((sent) => sent.paths.includes(BACKUP_AUTOMATION_NAME))).toBe(true)
  })

  it('refuses a library file whose checksum does not match the manifest', async () => {
    const sameSize = new Uint8Array(automationBytes)
    sameSize[sameSize.length - 2] = sameSize[sameSize.length - 2] === 0x31 ? 0x32 : 0x31
    const files = backupFiles().map((file) => (file.name === BACKUP_AUTOMATION_NAME ? fileOf(BACKUP_AUTOMATION_NAME, sameSize) : file))
    await expect(restore(files)).rejects.toThrow(/backup_file_checksum_failed/)
    expect(sends, 'a tampered library must not reach the server at all').toEqual([])
  })

  it('refuses a library file that is not the size the manifest promised', async () => {
    const files = backupFiles().map((file) => (
      file.name === BACKUP_AUTOMATION_NAME
        ? fileOf(BACKUP_AUTOMATION_NAME, new TextEncoder().encode('{"tampered":true}'))
        : file
    ))
    await expect(restore(files)).rejects.toThrow(/backup_file_size_mismatch/)
    expect(sends).toEqual([])
  })

  it('refuses a snapshot that promises the library but does not carry the file', async () => {
    const files = backupFiles().filter((file) => file.name !== BACKUP_AUTOMATION_NAME)
    await expect(restore(files)).rejects.toThrow(/backup_missing_file/)
  })

  it('restores a backup without a library file exactly as before', async () => {
    const plain = manifestWith(undefined)
    const plainBytes = new TextEncoder().encode(JSON.stringify(plain))
    const plainComplete = new TextEncoder().encode(
      `${MARKDOWN_BACKUP_FORMAT} v4\nmanifest-sha256 ${sha(plainBytes)}\n`,
    )
    await restore([
      fileOf('manifest.json', plainBytes),
      fileOf('COMPLETE', plainComplete),
      fileOf('notes/restored.md', noteBytes),
    ])
    expect(sends).toHaveLength(1)
    expect(sends[0].paths).toEqual(['notes/restored.md'])
  })
})

describe('the manifest contract around the automation entry', () => {
  it('accepts a version 4 manifest that names automation.json', () => {
    expect(parseMarkdownBackupManifest(manifest)?.automation).toEqual(manifest.automation)
  })

  it('accepts a version 3 manifest that predates the library', () => {
    const v3 = { ...manifest, version: 3, automation: undefined }
    const parsed = parseMarkdownBackupManifest(v3)
    expect(parsed?.version).toBe(3)
    expect(parsed?.automation).toBeUndefined()
  })

  it('refuses a library entry that names any other path or carries a bad checksum', () => {
    expect(parseMarkdownBackupManifest({
      ...manifest,
      automation: { ...manifest.automation!, path: 'notes/automation.json' },
    })).toBeNull()
    expect(parseMarkdownBackupManifest({
      ...manifest,
      automation: { ...manifest.automation!, sha256: 'not-a-hash' },
    })).toBeNull()
    expect(parseMarkdownBackupManifest({ ...manifest, automation: 'text' })).toBeNull()
  })
})

describe('the backup snapshot of the automation library', () => {
  let sqlite: DatabaseSync
  let env: { DB: D1Database }
  const NOTE_ID = newId()

  function seedColumn(value: string | null) {
    sqlite.prepare('UPDATE users SET quickadd = ?1 WHERE id = ?2').run(value, USER)
  }

  beforeEach(() => {
    sqlite = new DatabaseSync(':memory:')
    sqlite.exec(SCHEMA_STATEMENTS.join(';'))
    sqlite.prepare(
      `INSERT INTO users (id, username, password_hash, login, name, avatar_url, role, settings, created_at, last_seen_at)
       VALUES (?, 'one', 'h', 'one', 'One', '', 'member', '{}', 1, 1)`,
    ).run(USER)
    sqlite.prepare(
      `INSERT INTO notes (id, user_id, title, title_key, content, excerpt, rev, word_count, char_count, content_hash, created_at, updated_at)
       VALUES (?1, ?2, 'Hello', 'hello', '# Hello', 'Hello', 1, 1, 7, 'h', 1, 1)`,
    ).run(NOTE_ID, USER)
    env = { DB: makeD1(sqlite) }
  })

  async function automationFile(body: Uint8Array | null) {
    seedColumn(body === null ? null : new TextDecoder().decode(body))
    const snapshot = await buildSnapshot(env as never, USER)
    const file = snapshot.payloadFiles.find((entry) => entry.path === BACKUP_AUTOMATION_NAME)
    if (!file) return null
    const [materialized] = (await materializeSnapshot(snapshot)).filter((entry) => entry.path === BACKUP_AUTOMATION_NAME)
    const manifestFile = (await materializeSnapshot(snapshot)).find((entry) => entry.path === 'manifest.json')
    const parsed = parseMarkdownBackupManifest(JSON.parse(new TextDecoder().decode(manifestFile!.body)))
    return { file, text: new TextDecoder().decode(materialized!.body), manifest: parsed?.automation }
  }

  it('writes the library as the transport payload and pins it in the manifest', async () => {
    const payload = buildQuickAddPayload(
      { ...defaultQuickAddSettings(), dateFormat: 'MM/DD/YYYY' },
      [newCaptureChoice('c1', 'Quick capture', 0)],
    )
    const stored = JSON.stringify({
      savedAt: 5,
      version: QUICKADD_VERSION,
      library: parseQuickAddText(JSON.stringify(payload)).data,
    })
    const written = await automationFile(new TextEncoder().encode(stored))
    expect(written).not.toBeNull()
    const carried = JSON.parse(written!.text)
    expect(carried.app).toBe('inkstone')
    expect(carried.kind).toBe('quickadd')
    expect(carried.choices.map((choice: { name: string }) => choice.name)).toEqual(['Quick capture'])
    expect(carried.settings.dateFormat).toBe('MM/DD/YYYY')
    expect(written!.manifest).toEqual({
      path: BACKUP_AUTOMATION_NAME,
      bytes: written!.file.byteLength,
      sha256: written!.file.sha256,
    })
  })

  it('writes no library file for an account that has none, or whose column has gone to junk', async () => {
    expect(await automationFile(null)).toBeNull()
    expect(await automationFile(new TextEncoder().encode('not json at all'))).toBeNull()
  })
})
