// @vitest-environment node
// W5 operation limits and path rules, including the cases the live run cannot easily provoke.

import { describe, expect, it } from 'vitest'
import { listDirectory, readFileRange, writeFileChunks, SftpOperationError } from '../src/worker/webssh/sftp/operations'
import { normalizeSftpPath, SftpPathError, joinRemotePath } from '../src/worker/webssh/sftp/paths'
import { WEBSSH_SFTP_WIRE_CHUNK_BYTES } from '../src/worker/webssh/sftp/limits'
import { connectFake } from './webssh-sftp-test-utils'

describe('SFTP path rules', () => {
  it('normalizes duplicate separators and dot segments', () => {
    expect(normalizeSftpPath('//home//test/./notes.txt')).toBe('/home/test/notes.txt')
    expect(normalizeSftpPath('/')).toBe('/')
  })

  it('rejects traversal, relative paths and control characters', () => {
    expect(() => normalizeSftpPath('/home/../etc/passwd')).toThrow(SftpPathError)
    expect(() => normalizeSftpPath('home/test')).toThrow(SftpPathError)
    expect(() => normalizeSftpPath('/home/\u0000test')).toThrow(SftpPathError)
    expect(() => normalizeSftpPath('')).toThrow(SftpPathError)
  })

  it('joins a directory and an entry name without doubling the root separator', () => {
    expect(joinRemotePath('/', 'file.txt')).toBe('/file.txt')
    expect(joinRemotePath('/home', 'file.txt')).toBe('/home/file.txt')
  })
})

describe('SFTP directory listing', () => {
  it('drops dot entries and unsafe names', async () => {
    const { client } = connectFake({
      canonicalPath: '/home/test',
      directoryEntries: [
        { filename: '.', longname: '', attrs: { flags: 0, permissions: 0o40755, mtime: 1 } },
        { filename: '..', longname: '', attrs: { flags: 0, permissions: 0o40755, mtime: 1 } },
        { filename: 'notes.txt', longname: 'notes.txt', attrs: { flags: 0, size: 12, permissions: 0o100644, mtime: 99 } },
        { filename: 'name/with/slash', longname: 'name/with/slash', attrs: { flags: 0, size: 1, permissions: 0o100644, mtime: 99 } },
      ],
    })
    await client.initialize()
    const listing = await listDirectory(client, '/home/test')
    expect(listing.path).toBe('/home/test')
    expect(listing.entries.map((entry) => entry.name)).toEqual(['notes.txt'])
    expect(listing.entries[0]).toMatchObject({
      path: '/home/test/notes.txt',
      kind: 'file',
      size: 12,
      mtime: 99,
      permissions: '-rw-r--r--',
    })
  })
})

describe('SFTP read limits', () => {
  it('refuses a whole file larger than 2 GiB', async () => {
    const { client } = connectFake({ fileAttrs: { size: 2 * 1024 * 1024 * 1024 + 1, permissions: 0o100644, mtime: 1 } })
    await client.initialize()
    await expect(readFileRange(client, '/huge.bin', 0)).rejects.toMatchObject({ code: 'file_too_large' })
  })

  it('refuses a block larger than 64 MiB', async () => {
    const { client } = connectFake({ fileAttrs: { size: 12, permissions: 0o100644, mtime: 1 } })
    await client.initialize()
    await expect(readFileRange(client, '/notes.txt', 0, 64 * 1024 * 1024 + 1))
      .rejects.toBeInstanceOf(SftpOperationError)
  })

  it('assembles a multi-block read and honours the requested range', async () => {
    const content = new Uint8Array(WEBSSH_SFTP_WIRE_CHUNK_BYTES + 10).fill(0x61)
    const { client } = connectFake({ fileContent: content, fileAttrs: { size: content.length, permissions: 0o100644, mtime: 1 } })
    await client.initialize()
    const range = await readFileRange(client, '/big.txt', 5)
    expect(range.size).toBe(content.length)
    expect(range.data.length).toBe(content.length - 5)
  })
})

describe('SFTP write limits', () => {
  it('splits large chunks into 64 KiB WRITEs and checks the declared size', async () => {
    const { client, server } = connectFake()
    await client.initialize()
    const payload = new Uint8Array(WEBSSH_SFTP_WIRE_CHUNK_BYTES + 100).fill(0x62)
    await writeFileChunks(client, '/home/test/upload.bin', payload.length, (async function* () { yield payload })())
    expect(server.writes).toEqual([
      { offset: 0, length: WEBSSH_SFTP_WIRE_CHUNK_BYTES },
      { offset: WEBSSH_SFTP_WIRE_CHUNK_BYTES, length: 100 },
    ])
  })

  it('rejects a declared size larger than the streamed bytes', async () => {
    const { client } = connectFake()
    await client.initialize()
    await expect(writeFileChunks(client, '/home/test/upload.bin', 100, (async function* () { yield new Uint8Array(10) })()))
      .rejects.toMatchObject({ code: 'size_mismatch' })
  })

  it('rejects an upload larger than 2 GiB before opening the file', async () => {
    const { client, server } = connectFake()
    await client.initialize()
    await expect(writeFileChunks(client, '/home/test/huge.bin', 2 * 1024 * 1024 * 1024 + 1, (async function* () {})()))
      .rejects.toMatchObject({ code: 'file_too_large' })
    expect(server.writes).toHaveLength(0)
  })
})
