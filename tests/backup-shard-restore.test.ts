// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import type { ExecutionContext } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import { buildSnapshot, materializeSnapshot } from '../src/worker/backup/snapshot'
import { createBackupArchive } from '../src/worker/backup/archive'
import { transferRoutes } from '../src/worker/routes/transfer'
import { errorResponse } from '../src/worker/lib/errors'
import type { AppBindings, Env } from '../src/worker/env'
import { makeD1 } from './doubles/d1-sqlite'
import {
  BACKUP_SHARD_INDEX_NAME,
  collectBackupShards,
  parseBackupShardIndex,
  restoreShardedBackupFiles,
  type BackupShardPage,
} from '../src/client/lib/backup-shards'
import type { MarkdownBackupManifest } from '../src/shared/backup-format'
import type { ImportResult } from '../src/shared/types'

const SOURCE_USER = 'user-source'
const TARGET_USER = 'user-target'
const STAMP = '20261125-010203-001'
const NOTE_COUNT = 5

function noteId(index: number): string {
  return String(index).padStart(26, '0')
}

function account(sqlite: DatabaseSync, id: string): void {
  sqlite.prepare(
    `INSERT INTO users (id, username, password_hash, login, name, avatar_url, role, settings, created_at, last_seen_at)
     VALUES (?, ?, 'hash', ?, '', '', 'member', '{}', 1, 1)`,
  ).run(id, id, id)
}

function seedSource(sqlite: DatabaseSync): void {
  account(sqlite, SOURCE_USER)
  for (let index = 1; index <= NOTE_COUNT; index++) {
    sqlite.prepare(
      `INSERT INTO notes (id, user_id, title, content, rev, created_at, updated_at)
       VALUES (?, ?, ?, ?, 1, ?, ?)`,
    ).run(noteId(index), SOURCE_USER, `Note ${index}`, `Body ${index}`, index, index)
  }
}

let source: DatabaseSync
let target: DatabaseSync
let targetDb: D1Database
let app: Hono<AppBindings>

beforeEach(() => {
  vi.stubGlobal('FixedLengthStream', class extends TransformStream<Uint8Array, Uint8Array> {
    constructor(_length: bigint) { super() }
  })
  source = new DatabaseSync(':memory:')
  target = new DatabaseSync(':memory:')
  source.exec(SCHEMA_STATEMENTS.join(';'))
  target.exec(SCHEMA_STATEMENTS.join(';'))
  seedSource(source)
  account(target, TARGET_USER)
  targetDb = makeD1(target)
  app = new Hono<AppBindings>()
  app.onError((err, c) => errorResponse(c, err))
  app.use('*', async (c, next) => {
    c.set('userId', TARGET_USER)
    c.set('database', { ftsEnabled: false })
    await next()
  })
  app.route('/api', transferRoutes)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('sharded backup restore drill', () => {
  it('splits a library into restorable shards and restores every note into an empty account', async () => {
    const env = { DB: makeD1(source) } as unknown as Env
    const pages: Array<{ afterId: string, page: BackupShardPage }> = []
    let afterId = ''
    for (let count = 0; count < 20; count++) {
      const snapshot = await buildSnapshot(env, SOURCE_USER, {
        afterId,
        snapshot: STAMP,
        maxBytes: 4096,
        includeAuxiliary: false,
      })
      const archive = createBackupArchive(snapshot)
      const blob = new Blob([await new Response(archive.stream).arrayBuffer()], { type: 'application/zip' })
      const page: BackupShardPage = {
        blob,
        snapshot: snapshot.stamp,
        nextAfterId: snapshot.nextAfterId,
        noteCount: snapshot.noteCount,
        attachmentCount: snapshot.attachmentCount,
      }
      pages.push({ afterId, page })
      if (!snapshot.nextAfterId) break
      afterId = snapshot.nextAfterId
    }
    expect(pages.length).toBeGreaterThan(1)
    expect(pages.reduce((sum, entry) => sum + entry.page.noteCount, 0)).toBe(NOTE_COUNT)

    const files = new Map<string, File>()
    let indexFile: File | null = null
    const index = await collectBackupShards(
      async (cursor, snapshot) => {
        const found = pages.find((entry) => entry.afterId === cursor)
        if (!found) throw new Error(`Unexpected cursor: ${cursor}`)
        expect(found.page.snapshot).toBe(snapshot || STAMP)
        return found.page
      },
      async (name, blob) => { files.set(name, new File([blob], name, { type: 'application/zip' })) },
      async (value) => { indexFile = new File([JSON.stringify(value)], BACKUP_SHARD_INDEX_NAME, { type: 'application/json' }) },
    )
    expect(index.complete).toBe(true)
    expect(index.shards).toHaveLength(pages.length)
    expect(indexFile).not.toBeNull()

    const result = await restoreShardedBackupFiles([...files.values(), indexFile!], async (batch, manifest, paths) => {
      const form = new FormData()
      form.set('conflict', 'newer')
      form.set('backupManifest', JSON.stringify(manifest))
      form.set('backupPaths', JSON.stringify(paths))
      for (const file of batch) form.append('file', file, file.name)
      const tasks: Promise<unknown>[] = []
      const ctx: ExecutionContext = {
        waitUntil: (task) => { tasks.push(task) },
        passThroughOnException: () => {},
        props: {},
      }
      const response = await app.request('/api/import', { method: 'POST', body: form }, { DB: targetDb } as unknown as AppBindings['Bindings'], ctx)
      await Promise.all(tasks)
      expect(response.status).toBe(200)
      return await response.json() as ImportResult
    })

    expect(result.createdNotes).toBe(NOTE_COUNT)
    expect(target.prepare('SELECT COUNT(*) AS count FROM notes WHERE user_id = ?').get(TARGET_USER)).toMatchObject({ count: NOTE_COUNT })
    for (let index = 1; index <= NOTE_COUNT; index++) {
      expect(target.prepare('SELECT title, content FROM notes WHERE id = ? AND user_id = ?').get(noteId(index), TARGET_USER))
        .toMatchObject({ title: `Note ${index}`, content: `Body ${index}` })
    }
  })

  it('serves a shard with snapshot and continuation headers', async () => {
    const tasks: Promise<unknown>[] = []
    const ctx: ExecutionContext = { waitUntil: (task) => { tasks.push(task) }, passThroughOnException: () => {}, props: {} }
    const response = await app.request('/api/export?format=shard', {}, { DB: targetDb } as unknown as AppBindings['Bindings'], ctx)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('application/zip')
    expect(response.headers.get('x-inkstone-backup-snapshot')).toMatch(/^\d{8}-\d{6}-\d{3}$/)
    expect(response.headers.get('x-inkstone-backup-next')).toBe('')
    expect(response.headers.get('x-inkstone-backup-notes')).toBe('0')
    await response.arrayBuffer()
    await Promise.all(tasks)
  })

  it('refuses an incomplete or ambiguous shard index', () => {
    const valid = {
      format: 'inkstone-backup-shards',
      version: 1,
      snapshot: STAMP,
      complete: true,
      shards: [{ file: 'shard-001.zip', notes: 1, attachments: 0, bytes: 100 }],
    }
    expect(parseBackupShardIndex(valid)).not.toBeNull()
    expect(parseBackupShardIndex({ ...valid, complete: false })).toBeNull()
    expect(parseBackupShardIndex({ ...valid, shards: [...valid.shards, { ...valid.shards[0]!, file: 'SHARD-001.ZIP' }] })).toBeNull()
    expect(parseBackupShardIndex({ ...valid, shards: [{ ...valid.shards[0]!, file: '../shard.zip' }] })).toBeNull()
  })

  it('materializes each shard without changing its declared checksums', async () => {
    const env = { DB: makeD1(source) } as unknown as Env
    const snapshot = await buildSnapshot(env, SOURCE_USER, { snapshot: STAMP, includeAuxiliary: false })
    const materialized = await materializeSnapshot(snapshot)
    expect(materialized.some((file) => file.path === 'manifest.json')).toBe(true)
    expect(materialized.some((file) => file.path === 'COMPLETE')).toBe(true)
    expect(JSON.parse(new TextDecoder().decode(materialized.find((file) => file.path === 'manifest.json')!.body)) as MarkdownBackupManifest)
      .toMatchObject({ snapshot: STAMP })
  })
})
