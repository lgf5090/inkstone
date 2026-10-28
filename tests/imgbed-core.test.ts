import { describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { makeD1 } from './doubles/d1-sqlite'
import { IMGBED_SCHEMA_STATEMENTS } from '../src/worker/imgbed/schema'
import { buildFileId, categoryFor, normalizeTags, parseSearchQuery, sanitizeFolderPath, sanitizeFileName } from '../src/shared/imgbed/model'
import { fileAccessDecision, publicDirectoryAllowed } from '../src/worker/imgbed/access'
import { scopeAllows } from '../src/worker/imgbed/tokens'
import { insertFile, listFiles, getFileTags, setFileTags } from '../src/worker/imgbed/store'
import { imgbedDavRoutes } from '../src/worker/imgbed/dav'

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
      'imgbed_api_tokens', 'imgbed_blocked_ips', 'imgbed_upload_sessions',
    ]))
    expect(indexes.map((row) => row.name)).toEqual(expect.arrayContaining(['idx_imgbed_files_dir', 'idx_imgbed_file_tags_tag']))
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

  it('enforces whitelist mode and directory allowlists', () => {
    expect(fileAccessDecision({ file: { listType: 'None', label: 'None' }, access: { ...access, whiteListMode: true }, referer: null, requestHost: 'x', admin: false }).reason).toBe('whitelist')
    expect(fileAccessDecision({ file: { listType: 'White', label: 'adult' }, access: { ...access, whiteListMode: true }, referer: null, requestHost: 'x', admin: false }).allowed).toBe(true)
    expect(publicDirectoryAllowed('a/b', 'a')).toBe(true)
    expect(publicDirectoryAllowed('c', 'a')).toBe(false)
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
