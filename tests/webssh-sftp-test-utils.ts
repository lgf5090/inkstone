// A scripted SFTP v3 server for W5 unit tests. It parses the exact packets the client sends and
// answers with the v3 response shapes; no SSH transport is involved.

import { SFTPClient } from '../src/worker/webssh/sftp/client'
import {
  SFTP_ATTR_FLAGS,
  SFTP_OPEN_FLAGS,
  SFTP_PACKET_TYPES,
  SFTP_STATUS,
  type SFTPDirEntry,
} from '../src/worker/webssh/sftp/types'

const encoder = new TextEncoder()

export function uint32(value: number): Uint8Array {
  const out = new Uint8Array(4)
  new DataView(out.buffer).setUint32(0, value >>> 0, false)
  return out
}

export function uint64(value: number): Uint8Array {
  const out = new Uint8Array(8)
  const view = new DataView(out.buffer)
  view.setUint32(0, Math.floor(value / 2 ** 32), false)
  view.setUint32(4, value >>> 0, false)
  return out
}

export function sshString(value: string | Uint8Array): Uint8Array {
  const bytes = typeof value === 'string' ? encoder.encode(value) : value
  return join([uint32(bytes.length), bytes])
}

export function join(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

function attrs(input: { size?: number; permissions?: number; mtime?: number }): Uint8Array {
  let flags = 0
  const fields: Uint8Array[] = []
  if (input.size !== undefined) {
    flags |= SFTP_ATTR_FLAGS.SIZE
    fields.push(uint64(input.size))
  }
  if (input.permissions !== undefined) {
    flags |= SFTP_ATTR_FLAGS.PERMISSIONS
    fields.push(uint32(input.permissions))
  }
  if (input.mtime !== undefined) {
    flags |= SFTP_ATTR_FLAGS.ACCESS_MODIFY_TIME
    fields.push(uint32(input.mtime), uint32(input.mtime))
  }
  return join([uint32(flags), ...fields])
}

function nameEntry(filename: string, entryAttrs: Uint8Array, longname = ''): Uint8Array {
  return join([sshString(filename), sshString(longname), entryAttrs])
}

export function typeByte(value: number): Uint8Array {
  return new Uint8Array([value])
}

function status(id: number, code: number, description = ''): Uint8Array {
  return join([typeByte(SFTP_PACKET_TYPES.STATUS), uint32(id), uint32(code), sshString(description), sshString('')])
}

export interface FakeAttrs {
  size?: number
  permissions?: number
  mtime?: number
}

export interface FakeSftpOptions {
  canonicalPath?: string
  fileAttrs?: FakeAttrs
  fileContent?: Uint8Array
  directoryEntries?: SFTPDirEntry[]
  posixRename?: boolean
  capabilities?: { lstat?: boolean; fstat?: boolean; setstat?: boolean; fsetstat?: boolean }
}

export class FakeSftpServer {
  readonly requestTypes: number[] = []
  readonly writes: Array<{ offset: number; length: number }> = []
  readonly mutations: Array<{ type: number; path?: string }> = []
  private client: SFTPClient | null = null
  private readDirCalls = 0
  private readonly options: Required<Pick<FakeSftpOptions, 'canonicalPath' | 'posixRename'>> & FakeSftpOptions

  constructor(options: FakeSftpOptions = {}) {
    this.options = {
      canonicalPath: options.canonicalPath ?? '/home/test',
      posixRename: options.posixRename ?? true,
      ...options,
    }
  }

  attach(client: SFTPClient): void {
    this.client = client
  }

  /** The client's `sendData` callback: decode one frame and answer it. */
  receive(frame: Uint8Array): void {
    const length = new DataView(frame.buffer, frame.byteOffset, 4).getUint32(0, false)
    const body = frame.subarray(4, 4 + length)
    const type = body[0]
    this.requestTypes.push(type)
    this.respond(type, body)
  }

  private respond(type: number, body: Uint8Array): void {
    if (type === SFTP_PACKET_TYPES.INIT) {
      const extensions = this.options.posixRename ? [sshString('posix-rename@openssh.com'), sshString('1')] : []
      this.send(join([typeByte(SFTP_PACKET_TYPES.VERSION), uint32(3), ...extensions]))
      return
    }
    const id = new DataView(body.buffer, body.byteOffset + 1, 4).getUint32(0, false)
    switch (type) {
      case SFTP_PACKET_TYPES.REALPATH:
        this.send(join([
          typeByte(SFTP_PACKET_TYPES.NAME),
          uint32(id),
          uint32(1),
          nameEntry(this.options.canonicalPath, attrs({ permissions: 0o40755, mtime: 1 })),
        ]))
        return
      case SFTP_PACKET_TYPES.OPENDIR:
        this.send(join([typeByte(SFTP_PACKET_TYPES.HANDLE), uint32(id), sshString('dir-handle')]))
        return
      case SFTP_PACKET_TYPES.READDIR: {
        this.readDirCalls += 1
        const entries = this.options.directoryEntries ?? []
        if (this.readDirCalls === 1) {
          this.send(join([
            typeByte(SFTP_PACKET_TYPES.NAME),
            uint32(id),
            uint32(entries.length),
            ...entries.map((entry) => nameEntry(
              entry.filename,
              attrs({
                size: typeof entry.attrs.size === 'number' ? entry.attrs.size : undefined,
                permissions: entry.attrs.permissions,
                mtime: entry.attrs.mtime,
              }),
              entry.longname,
            )),
          ]))
        } else {
          this.send(status(id, SFTP_STATUS.EOF))
        }
        return
      }
      case SFTP_PACKET_TYPES.STAT:
      case SFTP_PACKET_TYPES.LSTAT:
        if (type === SFTP_PACKET_TYPES.LSTAT && this.options.capabilities?.lstat === false) {
          this.send(status(id, SFTP_STATUS.OP_UNSUPPORTED, 'unsupported'))
          return
        }
        this.send(join([typeByte(SFTP_PACKET_TYPES.ATTRS), uint32(id), attrs(this.options.fileAttrs ?? { size: 12, permissions: 0o100644, mtime: 99 })]))
        return
      case SFTP_PACKET_TYPES.FSTAT:
        this.send(join([typeByte(SFTP_PACKET_TYPES.ATTRS), uint32(id), attrs(this.options.fileAttrs ?? { size: 12, permissions: 0o100644, mtime: 99 })]))
        return
      case SFTP_PACKET_TYPES.OPEN:
        this.send(join([typeByte(SFTP_PACKET_TYPES.HANDLE), uint32(id), sshString('file-handle')]))
        return
      case SFTP_PACKET_TYPES.READ: {
        const parsed = parseRead(body)
        const content = this.options.fileContent ?? encoder.encode('hello world!')
        if (parsed.offset >= content.length) {
          this.send(status(id, SFTP_STATUS.EOF))
          return
        }
        const data = content.subarray(parsed.offset, parsed.offset + parsed.length)
        this.send(join([typeByte(SFTP_PACKET_TYPES.DATA), uint32(id), sshString(data)]))
        return
      }
      case SFTP_PACKET_TYPES.WRITE: {
        const parsed = parseWrite(body)
        this.writes.push(parsed)
        this.send(status(id, SFTP_STATUS.OK))
        return
      }
      case SFTP_PACKET_TYPES.SETSTAT:
      case SFTP_PACKET_TYPES.FSETSTAT:
        this.mutations.push({ type })
        this.send(status(id, SFTP_STATUS.OK))
        return
      case SFTP_PACKET_TYPES.MKDIR:
      case SFTP_PACKET_TYPES.REMOVE:
      case SFTP_PACKET_TYPES.RMDIR:
      case SFTP_PACKET_TYPES.RENAME:
        this.mutations.push({ type, path: parseFirstString(body) })
        this.send(status(id, SFTP_STATUS.OK))
        return
      case SFTP_PACKET_TYPES.CLOSE:
        this.send(status(id, SFTP_STATUS.OK))
        return
      case SFTP_PACKET_TYPES.EXTENDED: {
        const extension = parseFirstString(body)
        if (extension === 'posix-rename@openssh.com' && this.options.posixRename) {
          this.mutations.push({ type, path: parseSecondString(body) })
          this.send(status(id, SFTP_STATUS.OK))
        } else {
          this.send(status(id, SFTP_STATUS.OP_UNSUPPORTED, 'unsupported extension'))
        }
        return
      }
      default:
        this.send(status(id, SFTP_STATUS.OP_UNSUPPORTED, 'unhandled request'))
    }
  }

  private send(body: Uint8Array): void {
    if (!this.client) throw new Error('Fake SFTP server has no client attached')
    this.client.feed(join([uint32(body.length), body]))
  }
}

function stringAt(body: Uint8Array, offset: number): { value: string; next: number } {
  const length = new DataView(body.buffer, body.byteOffset + offset, 4).getUint32(0, false)
  const start = offset + 4
  return { value: new TextDecoder().decode(body.subarray(start, start + length)), next: start + length }
}

function parseFirstString(body: Uint8Array): string {
  return stringAt(body, 5).value
}

function parseSecondString(body: Uint8Array): string {
  const first = stringAt(body, 5)
  return stringAt(body, first.next).value
}

function parseRead(body: Uint8Array): { offset: number; length: number } {
  const handle = stringAt(body, 5)
  const view = new DataView(body.buffer, body.byteOffset)
  const offset = Number(view.getBigUint64(handle.next, false))
  const length = view.getUint32(handle.next + 8, false)
  return { offset, length }
}

function parseWrite(body: Uint8Array): { offset: number; length: number } {
  const handle = stringAt(body, 5)
  const view = new DataView(body.buffer, body.byteOffset)
  const offset = Number(view.getBigUint64(handle.next, false))
  const data = stringAt(body, handle.next + 8)
  return { offset, length: data.value.length }
}

/** Connects a client to the scripted server and returns both. */
export function connectFake(options: FakeSftpOptions = {}): { client: SFTPClient; server: FakeSftpServer } {
  const server = new FakeSftpServer(options)
  const client = new SFTPClient((frame) => server.receive(frame), { requestTimeoutMs: 5_000 })
  server.attach(client)
  return { client, server }
}

export const OPEN_FLAGS = SFTP_OPEN_FLAGS
