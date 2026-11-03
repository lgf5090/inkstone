/**
 * The assistant's hands on the image bed.
 *
 * The image bed already had a store, a tag writer and a delete path; what it did not have was a way for
 * a turn to reach them. These cases run the tools the model actually calls, over a real D1 double, and
 * pin three things: the listing filters answer from the rows rather than from a guess, a tag write is
 * readable back, and the owner-only boundary is the one the HTTP routes draw — reading is open to a
 * member, tagging, statistics and deletion are not.
 *
 * The vision path is deliberately not exercised here: it needs a vision model and a configured key,
 * neither of which belongs in a unit fixture. Its refusal when the image bed has no vision settings is
 * covered, because that is the state a reader without the feature is in.
 */
import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_ASSISTANT_SETTINGS, type AssistantToolMode } from '../src/shared/assistant'
import { localDate } from '../src/shared/assistant-time'
import { ToolExecutor, type ToolContext } from '../src/worker/assistant/tools'
import type { AssistantStore } from '../src/worker/assistant/store'
import type { Env } from '../src/worker/env'
import { getFile } from '../src/worker/imgbed/store'
import { makeD1 } from './doubles/d1-sqlite'
import { testR2Bucket } from './doubles/bindings'

const OWNER = 'user-owner'
const MEMBER = 'user-member'
const IMAGE_NOW = '2026/11/screenshot-now.png'
const IMAGE_RECENT = '2026/11/screenshot-two-days.jpg'
const OLD_PDF = '2026/10/notes.pdf'

interface Seeded {
  env: Env
  userId: string
}

function seed(role: 'owner' | 'member' = 'owner'): Seeded {
  const sqlite = new DatabaseSync(':memory:')
  sqlite.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY, username TEXT NOT NULL, login TEXT NOT NULL, name TEXT NOT NULL,
      avatar_url TEXT NOT NULL DEFAULT '', role TEXT NOT NULL, settings TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL, last_seen_at INTEGER
    );
    CREATE TABLE imgbed_files (
      id TEXT PRIMARY KEY, object_key TEXT NOT NULL, file_name TEXT NOT NULL, file_type TEXT NOT NULL,
      file_size_bytes INTEGER NOT NULL, width INTEGER, height INTEGER, upload_ip TEXT,
      upload_address TEXT, list_type TEXT NOT NULL DEFAULT 'None', label TEXT NOT NULL DEFAULT 'None',
      directory TEXT NOT NULL DEFAULT '', source TEXT NOT NULL DEFAULT 'upload', external_link TEXT,
      channel TEXT NOT NULL DEFAULT 'CloudflareR2', channel_name TEXT NOT NULL DEFAULT 'R2_env',
      is_chunked INTEGER NOT NULL DEFAULT 0, parts TEXT, uploader_id TEXT,
      favorite INTEGER NOT NULL DEFAULT 0, pinned INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE INDEX idx_imgbed_files_created ON imgbed_files(created_at DESC, id);
    CREATE INDEX idx_imgbed_files_dir ON imgbed_files(directory, created_at DESC, id);
    CREATE INDEX idx_imgbed_files_type ON imgbed_files(file_type, created_at DESC);
    CREATE INDEX idx_imgbed_files_access ON imgbed_files(list_type, label, created_at DESC);
    CREATE INDEX idx_imgbed_files_ip ON imgbed_files(upload_ip, created_at DESC);
    CREATE INDEX idx_imgbed_files_channel ON imgbed_files(channel, channel_name, created_at DESC);
    CREATE INDEX idx_imgbed_files_favorite ON imgbed_files(favorite, created_at DESC);
    CREATE INDEX idx_imgbed_files_pinned ON imgbed_files(pinned, created_at DESC);
    CREATE VIRTUAL TABLE imgbed_files_fts USING fts5(file_name, file_id, tags, tokenize='trigram');
    CREATE TABLE imgbed_settings (
      key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE imgbed_file_tags (
      file_id TEXT NOT NULL, tag TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (file_id, tag)
    );
    CREATE INDEX idx_imgbed_file_tags_tag ON imgbed_file_tags(tag, file_id);
  `)

  const ownerId = role === 'owner' ? OWNER : MEMBER
  sqlite.prepare(`INSERT INTO users (id, username, login, name, role, created_at) VALUES (?, ?, ?, ?, ?, 1)`)
    .run(ownerId, ownerId, ownerId, ownerId, role)
  // The other account exists too, so a permission case is refused for the role rather than for a missing row.
  sqlite.prepare(`INSERT INTO users (id, username, login, name, role, created_at) VALUES (?, ?, ?, ?, ?, 1)`)
    .run('user-somebody', 'user-somebody', 'user-somebody', 'somebody', 'member')

  const now = Date.now()
  const rows: Array<{
    id: string, name: string, type: string, size: number, width: number | null, height: number | null,
    created: number, tags: string[], key: string
  }> = [
    { id: IMAGE_NOW, name: 'screenshot-now.png', type: 'image/png', size: 300 * 1024, width: 1920, height: 1080, created: now, tags: ['终端', '截图'], key: 'imgbed/images/screenshot-now.png' },
    { id: IMAGE_RECENT, name: 'screenshot-two-days.jpg', type: 'image/jpeg', size: 5 * 1024 * 1024, width: 1080, height: 1920, created: now - 2 * 86_400_000, tags: ['截图'], key: 'imgbed/images/screenshot-two-days.jpg' },
    { id: OLD_PDF, name: 'notes.pdf', type: 'application/pdf', size: 1024 * 1024, width: null, height: null, created: now - 10 * 86_400_000, tags: [], key: 'imgbed/other/notes.pdf' },
  ]
  for (const row of rows) {
    sqlite.prepare(
      `INSERT INTO imgbed_files (
         id, object_key, file_name, file_type, file_size_bytes, width, height, directory,
         source, channel, channel_name, uploader_id, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'cfr2', 'CloudflareR2', 'R2_env', ?, ?, ?)`,
    ).run(
      row.id, row.key, row.name, row.type, row.size, row.width, row.height,
      row.id.slice(0, row.id.lastIndexOf('/') + 1), OWNER, row.created, row.created,
    )
    const rowid = sqlite.prepare('SELECT rowid AS id FROM imgbed_files WHERE id = ?').get(row.id) as { id: number }
    sqlite.prepare('INSERT INTO imgbed_files_fts (rowid, file_name, file_id, tags) VALUES (?, ?, ?, ?)')
      .run(rowid.id, row.name, row.id, row.tags.join(' '))
    for (const tag of row.tags) {
      sqlite.prepare('INSERT INTO imgbed_file_tags (file_id, tag, created_at) VALUES (?, ?, ?)')
        .run(row.id, tag, row.created)
    }
  }
  return { env: { DB: makeD1(sqlite), FILES: testR2Bucket() } as unknown as Env, userId: ownerId }
}

function context(seeded: Seeded, over: Partial<ToolContext> = {}): ToolContext {
  return {
    store: { userId: seeded.userId } as unknown as AssistantStore,
    env: seeded.env,
    ftsEnabled: true,
    origin: 'https://notes.test',
    settings: DEFAULT_ASSISTANT_SETTINGS,
    timezone: 'Asia/Shanghai',
    dayEnd: Date.now(),
    mode: 'chat',
    conversationId: 'c1',
    memoryHistory: {} as ToolContext['memoryHistory'],
    memoryScope: { projectId: null },
    automations: {} as ToolContext['automations'],
    noteScope: async () => ({ restricted: false, folderIds: new Set(), tagIds: new Set(), noteIds: new Set() }),
    ...over,
  }
}

function run(seeded: Seeded, name: string, args: Record<string, unknown> = {}, over: Partial<ToolContext> = {}) {
  return new ToolExecutor(context(seeded, over), { maxToolCalls: 8 }).execute(name, args, 'call-1')
}

function destructiveAuto(): Partial<ToolContext> {
  return {
    settings: {
      ...DEFAULT_ASSISTANT_SETTINGS,
      toolModes: { ...DEFAULT_ASSISTANT_SETTINGS.toolModes, destructive: 'auto' as AssistantToolMode },
    },
  }
}

let seeded: Seeded

beforeEach(() => {
  seeded = seed('owner')
})

describe('img_search', () => {
  it('finds a file by its exact tag', async () => {
    const result = await run(seeded, 'img_search', { tag: '终端' }) as Record<string, unknown>
    expect(result.total).toBe(1)
    expect(result.returned).toBe(1)
    const files = result.files as Array<Record<string, unknown>>
    expect(files[0]).toMatchObject({ id: IMAGE_NOW, name: 'screenshot-now.png' })
    expect((files[0]!.tags as string[]).sort()).toEqual(['截图', '终端'])
    expect(String(files[0]!.url)).toContain('/imgbed/file/')
  })

  it('finds a file by words in its name', async () => {
    const result = await run(seeded, 'img_search', { search: 'screenshot' }) as Record<string, unknown>
    expect(result.total).toBe(2)
    expect((result.files as Array<Record<string, unknown>>).map((file) => file.id)).toEqual([IMAGE_NOW, IMAGE_RECENT])
  })

  it('honours a local date range, a kind, and a file size together', async () => {
    const today = localDate(Date.now(), 'Asia/Shanghai')
    const todayOnly = await run(seeded, 'img_search', { from: today, to: today }) as Record<string, unknown>
    expect((todayOnly.files as Array<Record<string, unknown>>).map((file) => file.id)).toEqual([IMAGE_NOW])

    const pictures = await run(seeded, 'img_search', { type: 'image' }) as Record<string, unknown>
    expect(pictures.total).toBe(2)

    const narrow = await run(seeded, 'img_search', {
      type: 'image', minSizeMB: 1, maxSizeMB: 10, orientation: 'portrait',
    }) as Record<string, unknown>
    expect((narrow.files as Array<Record<string, unknown>>).map((file) => file.id)).toEqual([IMAGE_RECENT])
    expect(narrow.note).toBeTruthy()
  })

  it('refuses a date it cannot read instead of returning the whole library', async () => {
    await expect(run(seeded, 'img_search', { from: '昨天' })).rejects.toThrow(/YYYY-MM-DD/)
  })
})

describe('img_recent', () => {
  it('lists the newest files inside the window, newest first', async () => {
    const result = await run(seeded, 'img_recent', { days: 3 }) as Record<string, unknown>
    expect(result.days).toBe(3)
    expect(result.total).toBe(2)
    expect((result.files as Array<Record<string, unknown>>).map((file) => file.id)).toEqual([IMAGE_NOW, IMAGE_RECENT])
    expect(result.from).toBe(localDate(Date.now() - 3 * 86_400_000, 'Asia/Shanghai'))
  })
})

describe('img_info', () => {
  it('reads one file by id or by a name that matches exactly one row', async () => {
    const byId = await run(seeded, 'img_info', { id: IMAGE_NOW }) as { file: Record<string, unknown> }
    expect(byId.file).toMatchObject({
      id: IMAGE_NOW, type: 'image/png', dimensions: '1920x1080', access: 'None',
    })
    expect((byId.file.tags as string[]).sort()).toEqual(['截图', '终端'])
    const byName = await run(seeded, 'img_info', { id: 'notes.pdf' }) as { file: Record<string, unknown> }
    expect(byName.file).toMatchObject({ id: OLD_PDF, type: 'application/pdf', tags: [] })
  })

  it('says how to find the id instead of guessing', async () => {
    await expect(run(seeded, 'img_info', { id: 'nothing-like-this' })).rejects.toThrow(/img_search/)
  })
})

describe('img_tag', () => {
  it('adds tags to several files and they read back', async () => {
    const result = await run(seeded, 'img_tag', {
      ids: [IMAGE_NOW, IMAGE_RECENT], tags: ['已整理', '风景'], action: 'add',
    }) as Record<string, unknown>
    expect(result.updated).toBe(2)
    expect(result.failed).toBe(0)
    const stored = await getFile(seeded.env.DB, IMAGE_RECENT)
    expect(stored?.tags).toEqual(expect.arrayContaining(['截图', '已整理', '风景']))
  })

  it('replaces and removes tags for the named files only', async () => {
    await run(seeded, 'img_tag', { ids: [IMAGE_NOW], tags: ['唯一'], action: 'set' })
    expect((await getFile(seeded.env.DB, IMAGE_NOW))?.tags).toEqual(['唯一'])
    expect((await getFile(seeded.env.DB, IMAGE_RECENT))?.tags).toEqual(['截图'])
    await run(seeded, 'img_tag', { ids: [IMAGE_NOW], tags: ['唯一'], action: 'remove' })
    expect((await getFile(seeded.env.DB, IMAGE_NOW))?.tags).toEqual([])
  })

  it('refuses a tag the image bed cannot store, before writing anything', async () => {
    await expect(run(seeded, 'img_tag', { ids: [IMAGE_NOW], tags: ['bad tag!'] })).rejects.toThrow(/not a tag/)
    expect((await getFile(seeded.env.DB, IMAGE_NOW))?.tags.sort()).toEqual(['截图', '终端'])
  })

  it('refuses vision when no vision model is configured, per file, without leaving a half-tag', async () => {
    const result = await run(seeded, 'img_tag', { ids: [IMAGE_NOW, OLD_PDF], vision: true }) as Record<string, unknown>
    expect(result.updated).toBe(0)
    expect(result.failed).toBe(2)
    const failures = result.results as Array<Record<string, unknown>>
    expect(failures[0]?.error).toMatch(/AI tagging is disabled/)
    expect((await getFile(seeded.env.DB, IMAGE_NOW))?.tags.sort()).toEqual(['截图', '终端'])
  })

  it('is refused to a member, because the screen refuses that too', async () => {
    const member = seed('member')
    await expect(run(member, 'img_tag', { ids: [IMAGE_NOW], tags: ['终端'] })).rejects.toThrow(/owner/i)
    expect((await getFile(member.env.DB, IMAGE_NOW))?.tags.sort()).toEqual(['截图', '终端'])
  })
})

describe('img_stats', () => {
  it('reports the real totals, sizes and tag distribution', async () => {
    const result = await run(seeded, 'img_stats') as Record<string, unknown>
    expect(result.totalFiles).toBe(3)
    expect(result.totalBytes).toBe(300 * 1024 + 5 * 1024 * 1024 + 1024 * 1024)
    expect(result.categories).toMatchObject({ images: 2, other: 1 })
    expect(result.topTags).toEqual([
      { tag: '截图', count: 2 },
      { tag: '终端', count: 1 },
    ])
    expect(result.channels).toEqual([{ channel: 'R2_env', files: 3, size: '6.3 MB' }])
  })

  it('is refused to a member, like the manage route', async () => {
    const member = seed('member')
    await expect(run(member, 'img_stats')).rejects.toThrow(/owner/i)
  })

  it('still lets a member read the library', async () => {
    const member = seed('member')
    const result = await run(member, 'img_search', { tag: '终端' }) as Record<string, unknown>
    expect(result.total).toBe(1)
  })
})

describe('img_delete', () => {
  it('deletes the files only once the approval path runs, and removes their rows', async () => {
    const result = await run(seeded, 'img_delete', {
      ids: [IMAGE_NOW, OLD_PDF],
    }, destructiveAuto()) as Record<string, unknown>
    expect(result.deleted).toBe(2)
    expect(result.failed).toEqual([])
    expect(await getFile(seeded.env.DB, IMAGE_NOW)).toBeNull()
    expect(await getFile(seeded.env.DB, OLD_PDF)).toBeNull()
    expect(await getFile(seeded.env.DB, IMAGE_RECENT)).not.toBeNull()
  })

  it('is refused to a member before anything is looked up', async () => {
    const member = seed('member')
    await expect(run(member, 'img_delete', { ids: [IMAGE_NOW] }, destructiveAuto())).rejects.toThrow(/owner/i)
    expect(await getFile(member.env.DB, IMAGE_NOW)).not.toBeNull()
  })
})
