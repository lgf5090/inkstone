// @vitest-environment node
// W5 SFTP v3 client framing and operations against the scripted server. The live test with a
// real OpenSSH sftp-server is separate; this suite pins request/response shapes and limits.

import { describe, expect, it } from 'vitest'
import { SFTPClient, SFTPProtocolError, SFTPStatusError } from '../src/worker/webssh/sftp/client'
import { SFTP_PACKET_TYPES, SFTP_STATUS, SFTP_OPEN_FLAGS } from '../src/worker/webssh/sftp/types'
import { connectFake, join, sshString, typeByte, uint32 } from './webssh-sftp-test-utils'

describe('SFTP client handshake', () => {
  it('sends INIT and accepts VERSION with the posix-rename extension', async () => {
    const { client, server } = connectFake()
    const info = await client.initialize()
    expect(info.version).toBe(3)
    expect(info.extensions.get('posix-rename@openssh.com')).toBe('1')
    expect(client.posixRenameSupported).toBe(true)
    expect(server.requestTypes).toEqual([SFTP_PACKET_TYPES.INIT])
  })

  it('reassembles a VERSION packet split across several channel chunks', async () => {
    let client!: SFTPClient
    client = new SFTPClient((frame) => {
      const body = frame.subarray(4)
      if (body[0] !== SFTP_PACKET_TYPES.INIT) return
      const versionBody = join([
        typeByte(SFTP_PACKET_TYPES.VERSION),
        uint32(3),
        sshString('posix-rename@openssh.com'),
        sshString('1'),
      ])
      const response = join([uint32(versionBody.length), versionBody])
      void Promise.resolve().then(() => {
        client.feed(response.subarray(0, 5))
        client.feed(response.subarray(5, 6))
        client.feed(response.subarray(6))
      })
    })
    const info = await client.initialize()
    expect(info.extensions.get('posix-rename@openssh.com')).toBe('1')
  })

  it('rejects a server version other than 3', async () => {
    let client!: SFTPClient
    client = new SFTPClient((frame) => {
      const body = frame.subarray(4)
      if (body[0] !== SFTP_PACKET_TYPES.INIT) return
      const versionBody = join([typeByte(SFTP_PACKET_TYPES.VERSION), uint32(4)])
      client.feed(join([uint32(versionBody.length), versionBody]))
    })
    await expect(client.initialize()).rejects.toBeInstanceOf(SFTPProtocolError)
  })
})

describe('SFTP client operations', () => {
  it('walks REALPATH, OPENDIR and READDIR until EOF', async () => {
    const { client } = connectFake({
      canonicalPath: '/home/test',
      directoryEntries: [
        { filename: '.', longname: '', attrs: { flags: 0, permissions: 0o40755 } },
        { filename: '..', longname: '', attrs: { flags: 0, permissions: 0o40755 } },
        { filename: 'notes.txt', longname: 'notes.txt', attrs: { flags: 0, size: 12, permissions: 0o100644, mtime: 99 } },
      ],
    })
    await client.initialize()
    expect(await client.realpath('/home/test')).toBe('/home/test')
    const handle = await client.openDir('/home/test')
    const batch = await client.readDir(handle)
    expect(batch?.map((entry) => entry.filename)).toEqual(['.', '..', 'notes.txt'])
    expect(await client.readDir(handle)).toBeNull()
    await client.closeHandle(handle)
  })

  it('reads and writes with 64-bit offsets', async () => {
    const content = new TextEncoder().encode('hello world!')
    const { client, server } = connectFake({ fileContent: content })
    await client.initialize()
    const data = await client.readFile(new Uint8Array([1]), 0, content.length)
    expect(new TextDecoder().decode(data ?? new Uint8Array())).toBe('hello world!')
    const handle = await client.openFile('/home/test/notes.txt', SFTP_OPEN_FLAGS.WRITE | SFTP_OPEN_FLAGS.CREATE)
    await client.writeFile(handle, 3, new Uint8Array([0x61, 0x62]))
    expect(server.writes).toEqual([{ offset: 3, length: 2 }])
  })

  it('maps a STATUS error to SFTPStatusError', async () => {
    let client!: SFTPClient
    client = new SFTPClient((frame) => {
      const body = frame.subarray(4)
      if (body[0] === SFTP_PACKET_TYPES.INIT) {
        const versionBody = join([typeByte(SFTP_PACKET_TYPES.VERSION), uint32(3)])
        client.feed(join([uint32(versionBody.length), versionBody]))
      }
      if (body[0] === SFTP_PACKET_TYPES.STAT) {
        const statusBody = join([
          typeByte(SFTP_PACKET_TYPES.STATUS),
          body.subarray(1, 5),
          uint32(SFTP_STATUS.NO_SUCH_FILE),
          sshString('gone'),
          sshString(''),
        ])
        client.feed(join([uint32(statusBody.length), statusBody]))
      }
    })
    await client.initialize()
    await expect(client.stat('/missing')).rejects.toBeInstanceOf(SFTPStatusError)
  })

  it('uses RENAME for a plain move and the extension for overwrite', async () => {
    const { client, server } = connectFake()
    await client.initialize()
    await client.rename('/home/test/a', '/home/test/b')
    expect(server.mutations.at(-1)?.type).toBe(SFTP_PACKET_TYPES.RENAME)
    await client.rename('/home/test/a', '/home/test/c', true)
    expect(server.mutations.at(-1)?.type).toBe(SFTP_PACKET_TYPES.EXTENDED)
  })

  it('refuses overwrite when the server lacks posix-rename', async () => {
    const { client } = connectFake({ posixRename: false })
    await client.initialize()
    await expect(client.rename('/home/test/a', '/home/test/b', true)).rejects.toThrow('posix-rename')
  })

  it('supports LSTAT, FSTAT, SETSTAT and FSETSTAT', async () => {
    const { client, server } = connectFake()
    await client.initialize()
    expect((await client.lstat('/home/test/a')).size).toBe(12)
    expect((await client.fstat(new Uint8Array([1]))).permissions).toBe(0o100644)
    await client.setstat('/home/test/a', { permissions: 0o100600 })
    await client.fsetstat(new Uint8Array([1]), { mtime: 100, atime: 100 })
    expect(server.mutations.map((mutation) => mutation.type)).toEqual([
      SFTP_PACKET_TYPES.SETSTAT,
      SFTP_PACKET_TYPES.FSETSTAT,
    ])
  })
})
