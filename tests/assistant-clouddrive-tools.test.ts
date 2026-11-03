// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_ASSISTANT_SETTINGS, type PendingAction } from '../src/shared/assistant'
import { foldedName } from '../src/shared/clouddrive/model'
import { CLOUDDRIVE_SCHEMA_STATEMENTS } from '../src/worker/clouddrive/schema'
import { initialsOf } from '../src/worker/clouddrive/lib'
import { ensurePrimaryMount } from '../src/worker/clouddrive/store'
import { newId } from '../src/worker/lib/id'
import { ToolExecutor, runApprovedAction, type ToolContext } from '../src/worker/assistant/tools'
import type { AssistantStore } from '../src/worker/assistant/store'
import type { Env } from '../src/worker/env'
import { createUsersTable } from './doubles/users-table'
import { makeD1 } from './doubles/d1-sqlite'
import { testBindings, testR2Bucket } from './doubles/bindings'

/**
 * The Cloud Drive tools, driven the way the assistant drives them.
 *
 * `assistant-rules.test.ts` proves these names are registered, permissioned and labelled. This file
 * drives the executor against a real database, because what matters here is not the catalogue: a
 * search that misses a file whose name is actually there, a move that lands in the wrong folder, a
 * share link no browser can open, a delete that erases instead of trashing, or a path another account
 * owns that the model could reach by naming it.
 */

const ALICE = 'user-alice'
const BOB = 'user-bob'
const DAY = 86_400_000
const NOW = Date.now()

let sqlite: DatabaseSync
let env: Env
let pending: PendingAction[]

function fakeStore(userId: string): AssistantStore {
  return {
    userId,
    createPendingAction: async (input: {
      conversationId: string
      tool: string
      targetId: string
      targetLabel: string
      args?: Record<string, unknown>
    }) => {
      const action: PendingAction = {
        id: `a${pending.length + 1}`,
        conversationId: input.conversationId,
        tool: input.tool,
        targetId: input.targetId,
        targetLabel: input.targetLabel,
        args: input.args ?? {},
        status: 'pending',
        error: null,
        createdAt: NOW,
        expiresAt: NOW + DAY,
      }
      pending.push(action)
      return action
    },
    getPendingAction: async (id: string) => pending.find((action) => action.id === id) ?? null,
    claimPendingAction: async (id: string, status: 'approved' | 'cancelled') => {
      const action = pending.find((entry) => entry.id === id)
      if (!action || action.status !== 'pending') return false
      action.status = status
      return true
    },
    resolvePendingAction: async (id: string, patch: { status: PendingAction['status']; error?: string | null }) => {
      const action = pending.find((entry) => entry.id === id)
      if (!action) return
      action.status = patch.status
      action.error = patch.error ?? null
    },
  } as unknown as AssistantStore
}

function context(userId = ALICE, store = fakeStore(userId)): ToolContext {
  return {
    store,
    env,
    ftsEnabled: false,
    origin: 'https://inkstone.test',
    settings: DEFAULT_ASSISTANT_SETTINGS,
    timezone: 'Asia/Shanghai',
    dayEnd: NOW,
    mode: 'chat',
    conversationId: 'conv-drive',
    memoryHistory: {} as ToolContext['memoryHistory'],
    memoryScope: { projectId: null },
    automations: {} as ToolContext['automations'],
    noteScope: async () => ({ restricted: false, folderIds: new Set(), tagIds: new Set(), noteIds: new Set() }),
  }
}

function run(name: string, args: Record<string, unknown> = {}, userId = ALICE, store = fakeStore(userId)): Promise<unknown> {
  return new ToolExecutor(context(userId, store), { maxToolCalls: 8 }).execute(name, args, `call-${name}`)
}

async function insertEntry(options: {
  userId?: string
  mountId?: string
  parentId?: string
  path: string
  name: string
  kind?: 'folder' | 'file'
  size?: number
  category?: string
  uploadedAt?: number
  lastViewedAt?: number | null
  metadata?: string
  mime?: string
  storageKey?: string | null
}): Promise<string> {
  const id = newId()
  const uploadedAt = options.uploadedAt ?? NOW
  const kind = options.kind ?? 'file'
  // A real file has an object behind it, and the usage report counts objects; a fixture without a key
  // would make the storage figure read zero and hide the very thing the tool reports.
  const storageKey = options.storageKey === undefined
    ? (kind === 'file' ? `CloudDrive/${options.category ?? 'other'}/${id}` : null)
    : options.storageKey
  await env.DB.prepare(
    `INSERT INTO CloudDrive_files
       (id, user_id, mount_id, parent_id, kind, name, name_folded, name_initials, path,
        category, mime, size, etag, checksum, storage_kind, storage_key, metadata, color,
        starred_at, last_viewed_at, deleted_at, trash_batch, created_at, updated_at, uploaded_at, modified_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 'r2', ?, ?, '',
             NULL, ?, NULL, NULL, ?, ?, ?, ?)`,
  ).bind(
    id,
    options.userId ?? ALICE,
    options.mountId ?? 'primary',
    options.parentId ?? '',
    kind,
    options.name,
    foldedName(options.name),
    initialsOf(options.name),
    options.path,
    options.category ?? 'other',
    options.mime ?? 'application/octet-stream',
    options.size ?? 0,
    storageKey,
    options.metadata ?? '{}',
    options.lastViewedAt === undefined ? null : options.lastViewedAt,
    uploadedAt, uploadedAt, uploadedAt, uploadedAt,
  ).run()
  return id
}

function rowByPath(path: string, userId = ALICE): Promise<{ id: string; deleted_at: number | null; path: string; name: string } | null> {
  return env.DB.prepare(
    `SELECT id, deleted_at, path, name FROM CloudDrive_files WHERE user_id = ? AND path = ? ORDER BY updated_at DESC LIMIT 1`,
  ).bind(userId, path).first<{ id: string; deleted_at: number | null; path: string; name: string }>()
}

async function trashRow(path: string, userId = ALICE): Promise<void> {
  await env.DB.prepare('UPDATE CloudDrive_files SET deleted_at = ? WHERE user_id = ? AND path = ?')
    .bind(NOW, userId, path).run()
}

beforeEach(async () => {
  sqlite = new DatabaseSync(':memory:')
  for (const statement of CLOUDDRIVE_SCHEMA_STATEMENTS) sqlite.exec(statement)
  createUsersTable(sqlite)
  sqlite.exec(`INSERT INTO users (id, username, password_hash, login, name, role, created_at, last_seen_at)
    VALUES ('${ALICE}', 'alice', 'x', 'alice', 'Alice', 'owner', 1, 1)`)
  sqlite.exec(`INSERT INTO users (id, username, password_hash, login, name, role, created_at, last_seen_at)
    VALUES ('${BOB}', 'bob', 'x', 'bob', 'Bob', 'member', 1, 1)`)
  const db = makeD1(sqlite)
  env = testBindings(db, { FILES: testR2Bucket() })
  await ensurePrimaryMount(env.DB, ALICE)
  await ensurePrimaryMount(env.DB, BOB)
  pending = []

  await insertEntry({ path: '/归档', name: '归档', kind: 'folder' })
  await insertEntry({ path: '/截图', name: '截图', kind: 'folder' })
  const archiveId = (await rowByPath('/归档'))!.id
  const shotsId = (await rowByPath('/截图'))!.id
  await insertEntry({
    parentId: archiveId,
    path: '/归档/旧报告.pdf',
    name: '旧报告.pdf',
    category: 'documents',
    size: 1024,
    uploadedAt: NOW - 400 * DAY,
    lastViewedAt: NOW - 200 * DAY,
  })
  await insertEntry({
    parentId: archiveId,
    path: '/归档/2024 财报.pdf',
    name: '2024 财报.pdf',
    category: 'documents',
    size: 2048,
    uploadedAt: Date.parse('2024-03-01T00:00:00Z'),
    lastViewedAt: NOW - 2 * DAY,
  })
  await insertEntry({
    parentId: archiveId,
    path: '/归档/新截图.png',
    name: '新截图.png',
    category: 'images',
    size: 4096,
    lastViewedAt: NOW,
  })
  await insertEntry({
    parentId: shotsId,
    path: '/截图/shot-1.png',
    name: 'shot-1.png',
    category: 'images',
    size: 8192,
    lastViewedAt: NOW,
  })
  await insertEntry({ path: '/草稿.txt', name: '草稿.txt', category: 'txt', size: 512 })
})

describe('reading the drive', () => {
  it('lists the files in a folder that nobody has opened for 30 days', async () => {
    const answer = await run('drive_list', {
      path: '/归档',
      recursive: true,
      unviewedDays: 30,
      sort: 'uploaded',
    }) as { count: number; files: Array<{ name: string; lastViewedAt: string | null }> }
    expect(answer.count).toBe(1)
    expect(answer.files[0]!.name).toBe('旧报告.pdf')
    expect(answer.files[0]!.lastViewedAt).not.toBeNull()
  })

  it('finds a file by part of its name, including a year', async () => {
    const answer = await run('drive_list', { q: '2024 财报', recursive: true }) as { files: Array<{ name: string; path: string }> }
    expect(answer.files.map((file) => file.name)).toEqual(['2024 财报.pdf'])
    expect(answer.files[0]!.path).toBe('/归档/2024 财报.pdf')
  })

  it('narrows by type and size at the same time', async () => {
    const answer = await run('drive_list', { type: 'images', minSize: 5000, recursive: true }) as { files: Array<{ name: string; size: number }> }
    expect(answer.files).toEqual([expect.objectContaining({ name: 'shot-1.png', size: 8192 })])
  })

  it('reports a folder’s real size, when it was last opened and what is shared', async () => {
    const answer = await run('drive_info', { path: '/归档' }) as {
      sizeBytes: number
      itemCount: number
      fileCount: number
      folderCount: number
      lastViewedAt: string | null
      acl: { writable: boolean; activeGrants: number; activeShareLinks: number }
    }
    expect(answer.sizeBytes).toBe(1024 + 2048 + 4096)
    expect(answer.itemCount).toBe(3)
    expect(answer.fileCount).toBe(3)
    expect(answer.folderCount).toBe(0)
    expect(answer.lastViewedAt).not.toBeNull()
    expect(answer.acl.writable).toBe(true)
    expect(answer.acl.activeShareLinks).toBe(0)
  })

  it('adds up the storage the account is using', async () => {
    const answer = await run('drive_storage_stats') as {
      usedBytes: number
      counts: { files: number; folders: number; trashed: number }
      mounts: Array<{ id: string; readOnly: boolean }>
    }
    expect(answer.usedBytes).toBe(1024 + 2048 + 4096 + 8192 + 512)
    expect(answer.counts.files).toBe(5)
    expect(answer.counts.folders).toBe(2)
    expect(answer.mounts.find((mount) => mount.id === 'primary')?.readOnly).toBe(false)
  })
})

describe('changing the drive', () => {
  it('creates a folder and refuses a name that is already taken', async () => {
    const created = await run('drive_create_folder', { parentPath: '/归档', name: '财报归档' }) as {
      created: { path: string }
    }
    expect(created.created.path).toBe('/归档/财报归档')
    await expect(run('drive_create_folder', { parentPath: '/归档', name: '旧报告.pdf' }))
      .rejects.toThrow(/already exists/)
  })

  it('moves a file into another folder and reports where it landed', async () => {
    const moved = await run('drive_move', { paths: ['/归档/2024 财报.pdf'], toPath: '/截图' }) as {
      moved: number
      paths: Array<{ to?: string }>
    }
    expect(moved.moved).toBe(1)
    expect(moved.paths[0]!.to).toBe('/截图/2024 财报.pdf')
    expect((await rowByPath('/截图/2024 财报.pdf'))?.name).toBe('2024 财报.pdf')
  })

  it('renames one file in place', async () => {
    const renamed = await run('drive_rename', { path: '/截图/shot-1.png', name: '截图-1.png' }) as {
      renamed: { name: string; path: string }
    }
    expect(renamed.renamed.path).toBe('/截图/截图-1.png')
    expect((await rowByPath('/截图/截图-1.png'))?.name).toBe('截图-1.png')
  })

  it('returns a share link that really names the entry', async () => {
    const shared = await run('drive_share_link', { path: '/截图' }) as { url: string; slug: string; target: { kind: string } }
    expect(shared.url).toBe(`https://inkstone.test/d/${shared.slug}`)
    expect(shared.target.kind).toBe('folder')
    const row = await env.DB.prepare('SELECT target_kind, path, name FROM CloudDrive_shares WHERE slug = ?')
      .bind(shared.slug).first<{ target_kind: string; path: string; name: string }>()
    expect(row).toMatchObject({ target_kind: 'folder', path: '/截图', name: '截图' })
  })
})

describe('deleting goes through the reader', () => {
  it('raises a pending card and only trashes after Approve', async () => {
    const store = fakeStore(ALICE)
    const proposed = await run('drive_trash', { paths: ['/草稿.txt'] }, ALICE, store) as {
      status: string
      action: string
    }
    expect(proposed.status).toBe('awaiting_reader_approval')
    expect(proposed.action).toContain('草稿.txt')
    const row = await rowByPath('/草稿.txt')
    expect(row?.deleted_at).toBeNull()

    const [action] = pending
    expect(action).toMatchObject({ tool: 'drive_trash', targetId: row!.id })
    const approved = await runApprovedAction(store, context(ALICE, store), action!.id) as {
      action: { status: string }
      result?: string
    }
    expect(approved.action.status).toBe('approved')
    const trashed = await rowByPath('/草稿.txt')
    expect(trashed).not.toBeNull()
    expect(trashed?.deleted_at).not.toBeNull()
  })

  it('erases the trash only after a second approval', async () => {
    await trashRow('/草稿.txt')
    const store = fakeStore(ALICE)
    const proposed = await run('drive_empty_trash', {}, ALICE, store) as { status: string; action: string }
    expect(proposed.status).toBe('awaiting_reader_approval')
    expect(proposed.action).toContain('1 item')
    expect(await rowByPath('/草稿.txt')).not.toBeNull()

    const [action] = pending
    await runApprovedAction(store, context(ALICE, store), action!.id)
    expect(await rowByPath('/草稿.txt')).toBeNull()
  })
})

describe('what the assistant may not reach', () => {
  it('cannot read another account’s file by naming its path', async () => {
    await expect(run('drive_info', { path: '/归档/旧报告.pdf' }, BOB)).rejects.toThrow(/File not found/)
    const answer = await run('drive_list', { path: '/归档/旧报告.pdf' }, BOB).catch((error: Error) => error.message)
    expect(answer).toMatch(/File not found/)
  })

  it('refuses a read-only mount before touching a row', async () => {
    await env.DB.prepare(
      `INSERT INTO CloudDrive_mounts
         (user_id, id, storage_id, name, mount_path, read_only, cache_ttl, web_proxy, webdav_policy, weight,
          sort_order, enabled, remark, folder_summary, created_at, updated_at)
       VALUES (?, 'ro', 'primary', 'Read only', '/ro', 1, 300, 0, 'native_proxy', 1, 1, 1, '', 0, ?, ?)`,
    ).bind(ALICE, NOW, NOW).run()
    await expect(run('drive_create_folder', { mountId: 'ro', parentPath: '/', name: 'Nope' }))
      .rejects.toThrow(/read-only/i)
    await expect(run('drive_trash', { mountId: 'ro', paths: ['/草稿.txt'] }))
      .rejects.toThrow(/read-only/i)
  })

  it('refuses a folder whose password the assistant cannot supply', async () => {
    await insertEntry({ path: '/私密', name: '私密', kind: 'folder', metadata: '{}' })
    await env.DB.prepare(
      `INSERT INTO CloudDrive_meta (user_id, mount_id, path, password_hash, created_at, updated_at)
       VALUES (?, 'primary', '/私密', 'scrypt-hash', ?, ?)`,
    ).bind(ALICE, NOW, NOW).run()
    await expect(run('drive_list', { path: '/私密' })).rejects.toThrow(/password protected/i)
    await expect(run('drive_trash', { paths: ['/私密'] })).rejects.toThrow(/password protected/i)
  })

  it('cannot drive an external mount from the assistant', async () => {
    await env.DB.prepare(
      `INSERT INTO CloudDrive_storages (user_id, id, name, type, config, status, is_default, api_key_visible,
         read_quota, default_path, created_at, updated_at)
       VALUES (?, 'ext', 'WebDAV', 'webdav', '{}', 'enabled', 0, 0, 0, '/', ?, ?)`,
    ).bind(ALICE, NOW, NOW).run()
    await env.DB.prepare(
      `INSERT INTO CloudDrive_mounts
         (user_id, id, storage_id, name, mount_path, read_only, cache_ttl, web_proxy, webdav_policy, weight,
          sort_order, enabled, remark, folder_summary, created_at, updated_at)
       VALUES (?, 'webdav', 'ext', 'WebDAV', '/webdav', 0, 300, 0, 'native_proxy', 1, 2, 1, '', 0, ?, ?)`,
    ).bind(ALICE, NOW, NOW).run()
    await expect(run('drive_list', { mountId: 'webdav', path: '/' })).rejects.toThrow(/external mount/i)
  })
})
