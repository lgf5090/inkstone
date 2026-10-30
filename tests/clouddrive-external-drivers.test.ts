// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { CLOUDDRIVE_SCHEMA_STATEMENTS } from '../src/worker/clouddrive/schema'
import {
  externalDirectUrl,
  externalEntryId,
  externalFolderSize,
  externalProxyLocation,
  listExternal,
  parseExternalEntryId,
  readExternal,
} from '../src/worker/clouddrive/external'
import type { CloudDriveMountInfo } from '../src/worker/clouddrive/lib'
import { encryptCloudDriveCredentials, decryptCloudDriveCredentials } from '../src/worker/lib/crypto'
import { newId } from '../src/worker/lib/id'
import { isCredentialRecord, isScope } from '../src/worker/durable/credential-vault'
import type { Env } from '../src/worker/env'
import { makeD1 } from './doubles/d1-sqlite'
import { testBindings, testDurableObjectNamespace, testR2Bucket } from './doubles/bindings'

const USER = '0123456789abcdefghjkmnpqrs'

function makeVault(): DurableObjectNamespace {
  const entries = new Map<string, { scope: string; value: unknown }>()
  let sequence = 0
  return testDurableObjectNamespace(async (request) => {
    const url = new URL(request.url)
    const body = await request.json() as { scope?: string; value?: unknown; ciphertext?: string }
    if (url.pathname === '/encrypt') {
      const ciphertext = `vault-${++sequence}`
      entries.set(ciphertext, { scope: body.scope ?? '', value: body.value })
      return Response.json({ ciphertext })
    }
    if (url.pathname === '/decrypt') {
      const entry = entries.get(body.ciphertext ?? '')
      if (!entry || entry.scope !== body.scope) return Response.json({}, { status: 422 })
      return Response.json({ value: entry.value })
    }
    return new Response('not found', { status: 404 })
  })
}

let sqlite: DatabaseSync
let db: D1Database
let env: Env
let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  for (const statement of CLOUDDRIVE_SCHEMA_STATEMENTS) sqlite.exec(statement)
  db = makeD1(sqlite)
  env = testBindings(db, { FILES: testR2Bucket(), CREDENTIAL_VAULT: makeVault() })
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

async function mountWith(
  type: string,
  config: Record<string, unknown>,
  credentials: Record<string, string | number>,
): Promise<CloudDriveMountInfo> {
  const storageId = newId()
  const mountId = newId()
  const now = Date.now()
  const secret = await encryptCloudDriveCredentials(env, storageId, credentials)
  await db.prepare(
    `INSERT INTO CloudDrive_storages
       (user_id, id, name, type, config, credentials, status, is_default, api_key_visible, read_quota,
        default_path, last_used_at, last_test_at, last_test_status, created_at, updated_at)
     VALUES (?, ?, 'drive', ?, ?, ?, 'enabled', 0, 0, 0, '/', NULL, NULL, NULL, ?, ?)`,
  ).bind(USER, storageId, type, JSON.stringify(config), secret, now, now).run()
  await db.prepare(
    `INSERT INTO CloudDrive_mounts
       (user_id, id, storage_id, name, mount_path, read_only, cache_ttl, web_proxy, webdav_policy, weight,
        sort_order, enabled, created_at, updated_at)
     VALUES (?, ?, ?, 'Drive', '/drive', 1, 300, 0, 'native_proxy', 1, 0, 1, ?, ?)`,
  ).bind(USER, mountId, storageId, now, now).run()
  return {
    id: mountId,
    name: 'Drive',
    mountPath: '/drive',
    storageId,
    storageType: type,
    readOnly: true,
    enabled: true,
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function callUrl(index = 0): string {
  const input = fetchMock.mock.calls[index]![0] as string | Request
  return typeof input === 'string' ? input : input.url
}

describe('CloudDrive credential vault policy', () => {
  it('accepts a storage token bundle scoped to the storage id', () => {
    const scope = `clouddrive:${newId()}`
    expect(isScope(scope)).toBe(true)
    expect(isCredentialRecord(scope, { accessToken: 'a', refreshToken: 'r', expiresAt: 123, clientId: 'c' })).toBe(true)
    expect(isCredentialRecord(scope, { 'bad key': 'x' })).toBe(false)
    expect(isCredentialRecord(scope, { token: { nested: true } })).toBe(false)
    expect(isCredentialRecord(scope, {})).toBe(false)
  })
})

describe('external entry ids', () => {
  it('round-trips a driver ref without changing the display path', () => {
    const id = externalEntryId('m1', '/a/b.txt', 'ref:1')
    expect(parseExternalEntryId(id)).toEqual({ mountId: 'm1', path: '/a/b.txt', ref: 'ref:1' })
    const legacy = externalEntryId('m1', '/a/b.txt')
    expect(parseExternalEntryId(legacy)).toEqual({ mountId: 'm1', path: '/a/b.txt', ref: null })
  })

  it('rejects forged ids that would escape the mount root', () => {
    expect(parseExternalEntryId(externalEntryId('m1', '/../secret'))).toBeNull()
    expect(parseExternalEntryId(externalEntryId('m1', '/%2e%2e/secret'))).toBeNull()
  })
})

describe('GitHub driver', () => {
  it('lists with the configured branch and reads the raw contents endpoint', async () => {
    const mount = await mountWith('github', { repo: 'owner/repo', branch: 'dev', rootPath: 'docs' }, { token: 'gh-token' })
    fetchMock.mockResolvedValueOnce(jsonResponse([
      { name: 'a.txt', type: 'file', size: 3 },
      { name: 'sub', type: 'dir', size: 0 },
    ]))
    const listing = await listExternal(env, db, mount, '/')
    expect(listing.folders.map((entry) => entry.name)).toEqual(['sub'])
    expect(listing.files.map((entry) => entry.name)).toEqual(['a.txt'])
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://api.github.com/repos/owner/repo/contents/docs?ref=dev')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer gh-token')

    fetchMock.mockResolvedValueOnce(new Response('abc', { status: 200 }))
    const response = await readExternal(env, db, mount, '/a.txt', null)
    expect(await response?.text()).toBe('abc')
    const [readUrl, readInit] = fetchMock.mock.calls[1] as [string, RequestInit]
    expect(readUrl).toBe('https://api.github.com/repos/owner/repo/contents/docs/a.txt?ref=dev')
    expect((readInit.headers as Record<string, string>).Accept).toBe('application/vnd.github.raw')
  })
})

describe('Hugging Face driver', () => {
  it('lists a dataset tree and attaches the blob ref', async () => {
    const mount = await mountWith('huggingface', { repo: 'org/data', repoType: 'dataset', revision: 'v1' }, { token: 'hf' })
    fetchMock.mockResolvedValueOnce(jsonResponse([
      { type: 'directory', path: 'img', size: 0 },
      { type: 'file', path: 'readme.md', size: 10, oid: 'blob1' },
    ]))
    const listing = await listExternal(env, db, mount, '/')
    expect(listing.folders.map((entry) => entry.name)).toEqual(['img'])
    expect(listing.files[0]!.name).toBe('readme.md')
    expect(parseExternalEntryId(listing.files[0]!.id)?.ref).toBe('blob1')
    expect(fetchMock.mock.calls[0]![0]).toBe('https://huggingface.co/api/datasets/org/data/tree/v1')
  })
})

describe('OneDrive driver', () => {
  it('refreshes an expired token, persists it and lists children', async () => {
    const mount = await mountWith('onedrive', { rootPath: '' }, {
      accessToken: 'old',
      refreshToken: 'refresh-1',
      clientId: 'client',
      clientSecret: 'secret',
      expiresAt: 1,
    })
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('login.microsoftonline.com')) {
        return jsonResponse({ access_token: 'new-token', refresh_token: 'refresh-2', expires_in: 3600 })
      }
      if (url.includes('/root/children')) {
        return jsonResponse({ value: [{ id: 'item1', name: 'folder', folder: {}, size: 0 }] })
      }
      throw new Error(`unexpected ${url}`)
    })
    const listing = await listExternal(env, db, mount, '/')
    expect(listing.folders.map((entry) => entry.name)).toEqual(['folder'])
    expect(listing.folders[0]!.id).toBe(externalEntryId(mount.id, '/folder', 'item1'))
    const [, listInit] = fetchMock.mock.calls[1] as [string, RequestInit]
    expect((listInit.headers as Record<string, string>).Authorization).toBe('Bearer new-token')
    const stored = await db.prepare(`SELECT credentials FROM CloudDrive_storages WHERE id = ?`)
      .bind(mount.storageId).first<{ credentials: string }>()
    const decrypted = await decryptCloudDriveCredentials(env, mount.storageId, stored!.credentials)
    expect(decrypted).toMatchObject({ accessToken: 'new-token', refreshToken: 'refresh-2' })
  })
})

describe('Google Drive driver', () => {
  it('reads by item id with a byte range', async () => {
    const mount = await mountWith('googledrive', { folderId: 'root' }, { accessToken: 'g-token' })
    fetchMock.mockResolvedValueOnce(new Response('456', { status: 206, headers: { 'content-range': 'bytes 3-5/6' } }))
    const response = await readExternal(env, db, mount, '/file.txt', 'bytes=3-5', 'file-id')
    expect(await response?.text()).toBe('456')
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://www.googleapis.com/drive/v3/files/file-id?alt=media&supportsAllDrives=true')
    expect((init.headers as Record<string, string>).Range).toBe('bytes=3-5')
  })
})

describe('Discord driver', () => {
  it('lists attachments and reads one by its message ref', async () => {
    const mount = await mountWith('discord', { channelId: '123456789' }, { botToken: 'bot' })
    fetchMock.mockResolvedValueOnce(jsonResponse([
      {
        id: 'message-1',
        timestamp: '2026-10-01T00:00:00.000Z',
        attachments: [{ id: 'att-1', filename: 'report.pdf', size: 12, url: 'https://cdn.discordapp.com/att' }],
      },
    ]))
    const listing = await listExternal(env, db, mount, '/')
    expect(listing.files.map((entry) => entry.name)).toEqual(['report.pdf'])
    const entry = listing.files[0]!
    expect(parseExternalEntryId(entry.id)?.ref).toBe('123456789:message-1:att-1')

    fetchMock.mockResolvedValueOnce(jsonResponse({
      id: 'message-1',
      attachments: [{ id: 'att-1', filename: 'report.pdf', url: 'https://cdn.discordapp.com/att' }],
    }))
    fetchMock.mockResolvedValueOnce(new Response('bytes', { status: 200 }))
    const response = await readExternal(env, db, mount, entry.path, null, parseExternalEntryId(entry.id)?.ref)
    expect(await response?.text()).toBe('bytes')
    const [cdnUrl] = fetchMock.mock.calls[2] as [string, RequestInit]
    expect(cdnUrl).toBe('https://cdn.discordapp.com/att')
  })
})

describe('WebDAV driver', () => {
  it('lists namespace-decorated responses, skips the collection itself and decodes hrefs', async () => {
    const mount = await mountWith('webdav', { baseUrl: 'https://dav.example.com/dav/root', rootPath: '' }, {
      username: 'user',
      password: 'secret',
    })
    fetchMock.mockResolvedValueOnce(new Response(
      `<?xml version="1.0" encoding="utf-8"?>
       <D:multistatus xmlns:D="DAV:">
         <D:response xmlns:lp2="http://apache.org/dav/props/" xmlns:lp1="DAV:">
           <D:href>/dav/root/</D:href>
           <D:propstat><D:prop><lp1:resourcetype><D:collection/></lp1:resourcetype></D:prop></D:propstat>
         </D:response>
         <D:response xmlns:lp2="http://apache.org/dav/props/">
           <D:href>/dav/root/Folder%20One/</D:href>
           <D:propstat><D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop></D:propstat>
         </D:response>
         <D:response xmlns:lp2="http://apache.org/dav/props/">
           <D:href>https://dav.example.com/dav/root/photo%20one.jpg</D:href>
           <D:propstat><D:prop>
             <D:getcontentlength>42</D:getcontentlength>
             <D:getlastmodified>Wed, 01 Oct 2026 10:00:00 GMT</D:getlastmodified>
           </D:prop></D:propstat>
         </D:response>
       </D:multistatus>`,
      { status: 207, headers: { 'content-type': 'application/xml' } },
    ))
    const listing = await listExternal(env, db, mount, '/')
    expect(listing.folders.map((entry) => entry.name)).toEqual(['Folder One'])
    expect(listing.files.map((entry) => entry.name)).toEqual(['photo one.jpg'])
    expect(listing.files[0]!.size).toBe(42)
    const init = fetchMock.mock.calls[0]![1] as RequestInit
    expect(callUrl()).toBe('https://dav.example.com/dav/root/')
    expect((init.headers as Record<string, string>).Depth).toBe('1')
    expect((init.headers as Record<string, string>).Authorization).toBe(`Basic ${btoa('user:secret')}`)
  })

  it('adds a trailing slash to a base URL that lacks one', async () => {
    const mount = await mountWith('webdav', { baseUrl: 'https://dav.example.com/dav/root' }, { username: 'u', password: 'p' })
    fetchMock.mockResolvedValueOnce(new Response('<D:multistatus xmlns:D="DAV:"/>', { status: 207 }))
    await listExternal(env, db, mount, '/')
    expect(callUrl()).toBe('https://dav.example.com/dav/root/')
  })

  it('sums a folder recursively for the folder-size tool', async () => {
    const mount = await mountWith('webdav', { baseUrl: 'https://dav.example.com/dav/root' }, { username: 'u', password: 'p' })
    fetchMock.mockResolvedValueOnce(new Response(`<D:multistatus xmlns:D="DAV:">
      <D:response><D:href>/dav/root/a.txt</D:href><D:propstat><D:prop>
        <D:getcontentlength>10</D:getcontentlength></D:prop></D:propstat></D:response>
      <D:response><D:href>/dav/root/sub/</D:href><D:propstat><D:prop>
        <D:collection/></D:prop></D:propstat></D:response>
    </D:multistatus>`, { status: 207 }))
    fetchMock.mockResolvedValueOnce(new Response(`<D:multistatus xmlns:D="DAV:">
      <D:response><D:href>/dav/root/sub/b.txt</D:href><D:propstat><D:prop>
        <D:getcontentlength>5</D:getcontentlength></D:prop></D:propstat></D:response>
    </D:multistatus>`, { status: 207 }))
    expect(await externalFolderSize(env, db, mount, '/')).toEqual({ bytes: 15, truncated: false })
  })
})

describe('S3 driver', () => {
  const listXml = `<?xml version="1.0" encoding="UTF-8"?>
    <ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
      <Contents><Key>root/readme.txt</Key><LastModified>2026-10-01T10:00:00.000Z</LastModified><Size>7</Size></Contents>
      <CommonPrefixes><Prefix>root/docs/</Prefix></CommonPrefixes>
    </ListBucketResult>`

  it('uses path-style requests when pathStyle is true', async () => {
    const mount = await mountWith('s3', {
      endpoint: 'https://s3.example.com', bucketName: 'bucket', region: 'auto', pathStyle: true,
    }, { accessKeyId: 'key', secretAccessKey: 'secret' })
    fetchMock.mockResolvedValueOnce(new Response(listXml, { status: 200 }))
    const listing = await listExternal(env, db, mount, '/')
    expect(listing.folders.map((entry) => entry.name)).toEqual(['docs'])
    expect(listing.files.map((entry) => entry.name)).toEqual(['readme.txt'])
    expect(callUrl()).toBe('https://s3.example.com/bucket?list-type=2&delimiter=%2F&max-keys=1000')
  })

  it('uses virtual-hosted requests when pathStyle is false', async () => {
    const mount = await mountWith('s3', {
      endpoint: 'https://s3.example.com', bucketName: 'bucket', region: 'auto', pathStyle: false,
    }, { accessKeyId: 'key', secretAccessKey: 'secret' })
    fetchMock.mockResolvedValueOnce(new Response(listXml, { status: 200 }))
    await listExternal(env, db, mount, '/')
    expect(callUrl()).toBe('https://bucket.s3.example.com/?list-type=2&delimiter=%2F&max-keys=1000')
  })

  it('reads through the same addressing style as the list', async () => {
    const mount = await mountWith('s3', {
      endpoint: 'https://s3.example.com', bucketName: 'bucket', region: 'auto', pathStyle: false,
    }, { accessKeyId: 'key', secretAccessKey: 'secret' })
    fetchMock.mockResolvedValueOnce(new Response('bytes', { status: 200 }))
    const response = await readExternal(env, db, mount, '/readme.txt', null)
    expect(await response?.text()).toBe('bytes')
    expect(callUrl()).toBe('https://bucket.s3.example.com/readme.txt')
  })
})

describe('direct and proxied external links', () => {
  it('prefers a custom host for an S3 direct link', async () => {
    const mount = await mountWith('s3', {
      endpoint: 'https://s3.example.com', bucketName: 'bucket', rootPath: 'root', customHost: 'https://cdn.example.com/',
    }, { accessKeyId: 'key', secretAccessKey: 'secret' })
    expect(await externalDirectUrl(env, db, mount, '/readme.txt')).toBe('https://cdn.example.com/root/readme.txt')
    expect(await externalProxyLocation(env, db, mount, '/readme.txt')).toBeNull()
  })

  it('presigns an S3 object when only the endpoint is configured', async () => {
    const mount = await mountWith('s3', {
      endpoint: 'https://s3.example.com', bucketName: 'bucket', rootPath: 'root',
    }, { accessKeyId: 'key', secretAccessKey: 'secret' })
    const url = await externalDirectUrl(env, db, mount, '/readme.txt')
    expect(url).toContain('https://s3.example.com/bucket/root/readme.txt?')
    expect(url).toContain('X-Amz-Signature=')
  })

  it('wraps an S3 direct link in the configured proxy URL', async () => {
    const s3 = await mountWith('s3', {
      endpoint: 'https://s3.example.com', bucketName: 'bucket', customHost: 'https://cdn.example.com',
      urlProxy: 'https://proxy.example.com/fetch',
    }, { accessKeyId: 'key', secretAccessKey: 'secret' })
    expect(await externalProxyLocation(env, db, s3, '/readme.txt')).toBe(
      `https://proxy.example.com/fetch?url=${encodeURIComponent('https://cdn.example.com/readme.txt')}`,
    )
  })

  it('wraps a WebDAV source in the configured proxy URL', async () => {
    const dav = await mountWith('webdav', {
      baseUrl: 'https://dav.example.com/dav', rootPath: 'root', urlProxy: 'https://proxy.example.com/fetch',
    }, { username: 'u', password: 'p' })
    expect(await externalProxyLocation(env, db, dav, '/readme.txt')).toBe(
      `https://proxy.example.com/fetch?url=${encodeURIComponent('https://dav.example.com/dav/root/readme.txt')}`,
    )
  })
})

describe('Telegram driver', () => {
  it('reports that chat history cannot be listed', async () => {
    const mount = await mountWith('telegram', { chatId: '123' }, { botToken: 't' })
    await expect(listExternal(env, db, mount, '/')).rejects.toMatchObject({ code: 'clouddrive_mount_unavailable' })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
