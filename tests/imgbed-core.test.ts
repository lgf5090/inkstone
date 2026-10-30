import { describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { makeD1 } from './doubles/d1-sqlite'
import { IMGBED_SCHEMA_STATEMENTS } from '../src/worker/imgbed/schema'
import { buildFileId, categoryFor, normalizeTags, parseSearchQuery, sanitizeFolderPath, sanitizeFileName } from '../src/shared/imgbed/model'
import { fileAccessDecision, publicDirectoryAllowed } from '../src/worker/imgbed/access'
import { scopeAllows } from '../src/worker/imgbed/tokens'
import { deleteUploadParts, getSidebarData, insertFile, listFiles, getFileTags, listUploadParts, randomFile, setFileFlags, setFileTags, upsertUploadPart } from '../src/worker/imgbed/store'
import { imgbedDavRoutes } from '../src/worker/imgbed/dav'
import { redactImgbedFile } from '../src/worker/imgbed/manage'
import { boundedPartSizeMB } from '../src/worker/imgbed/upload-routes'
import { moveWholeFile } from '../src/worker/imgbed/storage'
import type { ResolvedChannel } from '../src/worker/imgbed/channels'
import type { ImgbedFile } from '../src/shared/imgbed/model'
import type { Env } from '../src/worker/env'

function database() {
  const sqlite = new DatabaseSync(':memory:')
  for (const statement of IMGBED_SCHEMA_STATEMENTS) sqlite.exec(statement)
  return { sqlite, db: makeD1(sqlite) }
}

const access = {
  allowedDomains: '', whiteListMode: false, imageTransformEnabled: false, imageTransformAllowedSizes: '',
}

describe('imgbed schema', () => {
  it('creates every table and index', () => {
    const { sqlite } = database()
    const tables = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]
    const indexes = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='index'").all() as { name: string }[]
    expect(tables.map((row) => row.name)).toEqual(expect.arrayContaining([
      'imgbed_files', 'imgbed_channels', 'imgbed_file_tags', 'imgbed_settings',
      'imgbed_api_tokens', 'imgbed_blocked_ips', 'imgbed_upload_sessions', 'imgbed_upload_parts',
    ]))
    expect(indexes.map((row) => row.name)).toEqual(expect.arrayContaining(['idx_imgbed_files_dir', 'idx_imgbed_file_tags_tag', 'idx_imgbed_upload_parts_session']))
    const columns = (sqlite.prepare("PRAGMA table_info(imgbed_files)").all() as { name: string }[]).map((row) => row.name)
    expect(columns).toEqual(expect.arrayContaining(['favorite', 'pinned']))
  })
})

describe('imgbed naming', () => {
  it('keeps default names and inserts a counter before the extension', async () => {
    const seen = new Set<string>()
    const exists = async (id: string) => seen.has(id)
    const first = await buildFileId({ fileName: 'a.jpg', fileType: 'image/jpeg', folder: 'x', nameType: 'default', now: 100, random: () => 0, exists })
    expect(first).toBe('x/1000_a.jpg')
    seen.add(first)
    const second = await buildFileId({ fileName: 'a.jpg', fileType: 'image/jpeg', folder: 'x', nameType: 'default', now: 100, random: () => 0, exists })
    expect(second).toBe('x/1000_a(1).jpg')
  })

  it('gives short names an extension and origin names their own', async () => {
    const short = await buildFileId({ fileName: 'a.jpg', fileType: 'image/jpeg', folder: '', nameType: 'short', now: 1, random: () => 0, exists: async () => false })
    expect(short).toMatch(/^[A-Z]{8}\.jpg$/)
    const origin = await buildFileId({ fileName: 'a.jpg', fileType: 'image/jpeg', folder: 'f', nameType: 'origin', exists: async () => false })
    expect(origin).toBe('f/a.jpg')
  })

  it('sanitizes traversal and unsafe characters', () => {
    expect(sanitizeFolderPath('../a/./b//c')).toBe('_/a/_/b/c')
    expect(sanitizeFileName('a b?.jpg')).toBe('a_b_.jpg')
  })

  it('classifies files and normalizes tags', () => {
    expect(categoryFor('image/jpeg', 'a.jpg')).toBe('images')
    expect(categoryFor('application/pdf', 'a.pdf')).toBe('documents')
    expect(normalizeTags([' Cat ', 'cat', '中文', 'bad tag'])).toEqual(['cat', '中文'])
    expect(parseSearchQuery('hello #cat -#dog')).toEqual({ keywords: 'hello', includeTags: ['cat'], excludeTags: ['dog'] })
  })
})

describe('imgbed access', () => {
  it('allows normal files and blocks explicit and adult files', () => {
    expect(fileAccessDecision({ file: { listType: 'None', label: 'None' }, access, referer: null, requestHost: 'x', admin: false }).allowed).toBe(true)
    expect(fileAccessDecision({ file: { listType: 'Block', label: 'None' }, access, referer: null, requestHost: 'x', admin: false }).reason).toBe('blocked')
    expect(fileAccessDecision({ file: { listType: 'None', label: 'adult' }, access, referer: null, requestHost: 'x', admin: false }).reason).toBe('blocked')
    expect(fileAccessDecision({ file: { listType: 'Block', label: 'None' }, access, referer: null, requestHost: 'x', admin: true }).allowed).toBe(true)
  })

  it('rejects embedded requests that omit the referer when a domain allowlist is set', () => {
    const allow = { ...access, allowedDomains: 'example.com' }
    expect(fileAccessDecision({ file: { listType: 'None', label: 'None' }, access: allow, referer: null, requestHost: 'img.example.com', admin: false, fetchDest: 'image' }).reason).toBe('domain')
    expect(fileAccessDecision({ file: { listType: 'None', label: 'None' }, access: allow, referer: null, requestHost: 'img.example.com', admin: false }).allowed).toBe(true)
    expect(fileAccessDecision({ file: { listType: 'None', label: 'None' }, access: allow, referer: 'https://example.com/page', requestHost: 'img.example.com', admin: false, fetchDest: 'image' }).allowed).toBe(true)
  })

  it('enforces whitelist mode and directory allowlists', () => {
    expect(fileAccessDecision({ file: { listType: 'None', label: 'None' }, access: { ...access, whiteListMode: true }, referer: null, requestHost: 'x', admin: false }).reason).toBe('whitelist')
    expect(fileAccessDecision({ file: { listType: 'White', label: 'adult' }, access: { ...access, whiteListMode: true }, referer: null, requestHost: 'x', admin: false }).allowed).toBe(true)
    expect(publicDirectoryAllowed('a/b', 'a')).toBe(true)
    expect(publicDirectoryAllowed('c', 'a')).toBe(false)
  })

  it('accepts hierarchical tags but not empty segments', () => {
    expect(normalizeTags(['工作/会议', '报告', '工作/会议'])).toEqual(['工作/会议', '报告'])
    expect(normalizeTags(['/工作', '工作/', '工作//会议', '  '])).toEqual([])
  })

  it('keeps token scopes minimal', () => {
    expect(scopeAllows(['upload'], 'upload')).toBe(true)
    expect(scopeAllows(['upload'], 'delete')).toBe(false)
    expect(scopeAllows(['manage'], 'delete')).toBe(true)
  })
})

describe('imgbed WebDAV', () => {
  it('advertises the DAV methods on OPTIONS', async () => {
    const response = await imgbedDavRoutes.request('/', { method: 'OPTIONS' })
    expect(response.status).toBe(200)
    expect(response.headers.get('DAV')).toBe('1')
    expect(response.headers.get('Allow')).toContain('PROPFIND')
    expect(response.headers.get('MS-Author-Via')).toBe('DAV')
  })
})


describe('imgbed WebDAV move', () => {
  const file = {
    id: 'from/one.png', objectKey: 'from/one.png', fileName: 'one.png', fileType: 'image/png',
  } as unknown as ImgbedFile
  const channel = (createDirectory: boolean): ResolvedChannel => ({
    id: 'c', type: 'webdav', name: 'W', fixed: false, enabled: true, hasCredentials: true,
    config: { baseUrl: 'https://dav.test/base', createDirectory }, credentials: { username: 'u', password: 'p' },
    quota: { enabled: false, limitGB: null, threshold: 95 },
  })

  it('creates the destination folder before MOVE', async () => {
    const calls: { method: string; url: string }[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: RequestInit) => {
      calls.push({ method: String(init?.method ?? 'GET'), url: String(input) })
      return new Response(null, { status: 201 })
    }))
    try {
      const result = await moveWholeFile({} as unknown as Env, channel(true), file, 'to/renamed.png', 'image/png')
      expect(result.objectKey).toBe('to/renamed.png')
      expect(calls.map((call) => call.method)).toEqual(['MKCOL', 'MOVE'])
      expect(calls[0]!.url).toBe('https://dav.test/base/to')
      expect(calls[1]!.url).toBe('https://dav.test/base/from/one.png')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('moves without creating folders when the setting is off', async () => {
    const methods: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (_input: unknown, init?: RequestInit) => {
      methods.push(String(init?.method ?? 'GET'))
      return new Response(null, { status: 201 })
    }))
    try {
      await moveWholeFile({} as unknown as Env, channel(false), file, 'to/renamed.png', 'image/png')
      expect(methods).toEqual(['MOVE'])
    } finally {
      vi.unstubAllGlobals()
    }
  })
})


describe('imgbed random selection', () => {
  it('filters by orientation and file type in SQL-like query semantics', async () => {
    const { db } = database()
    const base = {
      fileType: 'image/png', uploadIp: null, uploadAddress: null, source: 'cfr2',
      channel: 'CloudflareR2', channelName: 'R2', uploaderId: null, createdAt: 1,
    }
    await insertFile(db, { ...base, id: 'landscape.png', objectKey: 'k1', fileName: 'landscape.png', sizeBytes: 1, width: 200, height: 100 })
    await insertFile(db, { ...base, id: 'portrait.png', objectKey: 'k2', fileName: 'portrait.png', sizeBytes: 1, width: 100, height: 200 })
    await insertFile(db, { ...base, id: 'square.png', objectKey: 'k3', fileName: 'square.png', sizeBytes: 1, width: 100, height: 100 })
    expect((await randomFile(db, { dir: '', fileType: ['image'], accessStatus: ['normal'], orientation: 'landscape' }))?.id).toBe('landscape.png')
    expect((await randomFile(db, { dir: '', fileType: ['image'], accessStatus: ['normal'], orientation: 'portrait' }))?.id).toBe('portrait.png')
    expect((await randomFile(db, { dir: '', fileType: ['image'], accessStatus: ['normal'], orientation: 'square' }))?.id).toBe('square.png')
  })
})

describe('imgbed metadata redaction', () => {
  it('hides object keys, IPs and parts from list-only actors', () => {
    const file = {
      id: 'a.png', objectKey: 'secret/key', fileName: 'a.png', fileType: 'image/png', sizeBytes: 1,
      width: null, height: null, uploadIp: '203.0.113.1', uploadAddress: 'Somewhere', listType: 'None',
      label: 'None', directory: '', source: 'cfr2', externalLink: null, channel: 'CloudflareR2',
      channelName: 'R2', isChunked: false, parts: [{ index: 0, size: 1 }], uploaderId: null,
      favorite: false, pinned: false, createdAt: 1, updatedAt: 1, tags: [],
    } as unknown as Parameters<typeof redactImgbedFile>[0]
    expect(redactImgbedFile(file, true)).toBe(file)
    const redacted = redactImgbedFile(file, false)
    expect(redacted.objectKey).toBe('')
    expect(redacted.uploadIp).toBeNull()
    expect(redacted.uploadAddress).toBeNull()
    expect(redacted.parts).toBeNull()
    expect(redacted.fileName).toBe('a.png')
  })
})

describe('imgbed upload bounds', () => {
  it('clamps the configured part size per channel', () => {
    expect(boundedPartSizeMB(16, 'cfr2')).toBe(16)
    expect(boundedPartSizeMB(1, 'cfr2')).toBe(5)
    expect(boundedPartSizeMB(200, 'cfr2')).toBe(64)
    expect(boundedPartSizeMB(64, 'discord')).toBe(9)
    expect(boundedPartSizeMB(64, 'telegram')).toBe(16)
    expect(boundedPartSizeMB(Number.NaN, 's3')).toBe(16)
  })
})

describe('imgbed upload parts', () => {
  it('keeps sibling part rows when two writes interleave', async () => {
    const { db } = database()
    await Promise.all([
      upsertUploadPart(db, 'session-a', { index: 0, partNumber: 1, etag: 'e1', fileId: null, messageId: null, size: 10 }),
      upsertUploadPart(db, 'session-a', { index: 1, partNumber: 2, etag: 'e2', fileId: null, messageId: null, size: 20 }),
    ])
    expect(await listUploadParts(db, 'session-a')).toEqual([
      { index: 0, partNumber: 1, etag: 'e1', fileId: null, messageId: null, size: 10 },
      { index: 1, partNumber: 2, etag: 'e2', fileId: null, messageId: null, size: 20 },
    ])
    await upsertUploadPart(db, 'session-a', { index: 1, partNumber: 2, etag: 'e2b', fileId: null, messageId: null, size: 21 })
    expect((await listUploadParts(db, 'session-a'))[1]!.etag).toBe('e2b')
    await deleteUploadParts(db, 'session-a')
    expect(await listUploadParts(db, 'session-a')).toEqual([])
  })
})

describe('imgbed flags, tag scope and sidebar', () => {
  it('filters by favorite, pinned, tag prefix and tag search', async () => {
    const { db } = database()
    const base = {
      fileType: 'image/png', width: null, height: null, uploadIp: null, uploadAddress: null,
      source: 'cfr2', channel: 'CloudflareR2', channelName: 'R2', uploaderId: null, createdAt: 1,
    }
    await insertFile(db, { ...base, id: 'root.png', objectKey: 'k1', fileName: 'root.png', sizeBytes: 1 })
    await insertFile(db, { ...base, id: 'a/one.png', objectKey: 'k2', fileName: 'one.png', sizeBytes: 1 })
    await insertFile(db, { ...base, id: 'a/b/two.png', objectKey: 'k3', fileName: 'two.png', sizeBytes: 1 })
    await setFileTags(db, 'a/b/two.png', ['工作/会议', '报告'])
    await setFileFlags(db, ['root.png'], { favorite: true })
    await setFileFlags(db, ['a/one.png'], { pinned: true })
    expect((await listFiles(db, { dir: '', count: 50, favorite: true })).files.map((file) => file.id)).toEqual(['root.png'])
    const all = await listFiles(db, { dir: '', count: 50, recursive: true })
    expect(all.files[0]!.id).toBe('a/one.png')
    expect(all.files[0]!.pinned).toBe(true)
    expect((await listFiles(db, { dir: '', count: 50, recursive: true, tagPrefix: '工作' })).files.map((file) => file.id)).toEqual(['a/b/two.png'])
    expect((await listFiles(db, { dir: '', count: 50, recursive: true, search: '#工作' })).files.map((file) => file.id)).toEqual(['a/b/two.png'])
    const sidebar = await getSidebarData(db, { timezoneOffset: 0, days: 30 })
    expect(sidebar.counts).toMatchObject({ all: 3, favorite: 1, pinned: 1, images: 3, videos: 0, audios: 0, other: 0 })
    expect(sidebar.tags).toEqual([{ tag: '工作/会议', count: 1 }, { tag: '报告', count: 1 }])
    expect(sidebar.channels).toEqual([{ channel: 'CloudflareR2', channelName: 'R2', count: 3 }])
  })
})

describe('imgbed list', () => {
  it('returns direct files and subdirectories for a folder', async () => {
    const { db } = database()
    const base = {
      fileType: 'image/png', width: null, height: null, uploadIp: null, uploadAddress: null,
      source: 'cfr2', channel: 'CloudflareR2', channelName: 'R2', uploaderId: null, createdAt: 1,
    }
    await insertFile(db, { ...base, id: 'root.png', objectKey: 'k1', fileName: 'root.png', sizeBytes: 1 })
    await insertFile(db, { ...base, id: 'a/one.png', objectKey: 'k2', fileName: 'one.png', sizeBytes: 1 })
    await insertFile(db, { ...base, id: 'a/b/two.png', objectKey: 'k3', fileName: 'two.png', sizeBytes: 1 })
    const root = await listFiles(db, { dir: '', count: 50 })
    expect(root.files.map((file) => file.id)).toEqual(['root.png'])
    expect(root.directories).toEqual(['a/'])
    const a = await listFiles(db, { dir: 'a/', count: 50 })
    expect(a.files.map((file) => file.id)).toEqual(['a/one.png'])
    expect(a.directories).toEqual(['a/b/'])
    await setFileTags(db, 'a/one.png', ['cat'])
    expect(await getFileTags(db, 'a/one.png')).toEqual(['cat'])
    expect((await listFiles(db, { dir: '', count: 50, includeTags: ['cat'], recursive: true })).files.map((file) => file.id)).toEqual(['a/one.png'])
  })
})
