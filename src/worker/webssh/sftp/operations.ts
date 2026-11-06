// W5 SFTP operations shared by the Durable Object and the route tests: directory listing,
// bounded reads and streamed writes. Limits live in `limits.ts`, path rules in `paths.ts`.

import type { WebsshSftpEntry } from '@shared/webssh/types'
import type { SFTPClient } from './client'
import type { SFTPAttrs, SFTPFileKind } from './types'
import { formatSftpPermissions, getSftpFileKind } from './types'
import {
  WEBSSH_SFTP_MAX_BLOCK_BYTES,
  WEBSSH_SFTP_MAX_DIRECTORY_ENTRIES,
  WEBSSH_SFTP_MAX_FILE_BYTES,
  WEBSSH_SFTP_WIRE_CHUNK_BYTES,
} from './limits'
import { isSafeRemoteName, joinRemotePath } from './paths'

export class SftpOperationError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'SftpOperationError'
  }
}

export function sftpSize(value: SFTPAttrs['size'] | undefined): number {
  if (value === undefined) return 0
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0
}

function entryFromAttrs(directory: string, name: string, longname: string, attrs: SFTPAttrs): WebsshSftpEntry {
  return {
    name,
    path: joinRemotePath(directory, name),
    kind: getSftpFileKind(attrs) as SFTPFileKind,
    size: sftpSize(attrs.size),
    mtime: attrs.mtime ?? null,
    permissions: formatSftpPermissions(attrs),
    longname,
  }
}

/** REALPATH + OPENDIR/READDIR until EOF; `.`/`..` and unsafe names are dropped. */
export async function listDirectory(client: SFTPClient, path: string): Promise<{ path: string; entries: WebsshSftpEntry[] }> {
  const canonical = await client.realpath(path)
  const handle = await client.openDir(canonical)
  const entries: WebsshSftpEntry[] = []
  try {
    for (;;) {
      const batch = await client.readDir(handle)
      if (!batch) break
      for (const item of batch) {
        if (!isSafeRemoteName(item.filename)) continue
        entries.push(entryFromAttrs(canonical, item.filename, item.longname, item.attrs))
        if (entries.length > WEBSSH_SFTP_MAX_DIRECTORY_ENTRIES) {
          throw new SftpOperationError('too_many_entries', 'The directory has too many entries to list')
        }
      }
    }
  } finally {
    await client.closeHandle(handle).catch(() => undefined)
  }
  return { path: canonical, entries }
}

export async function statPath(client: SFTPClient, path: string): Promise<SFTPAttrs> {
  return client.stat(path)
}

export interface SftpReadRange {
  data: Uint8Array
  offset: number
  size: number
  attrs: SFTPAttrs
}

/**
 * Reads at most `length` bytes, defaulting to a full 64 MiB block. A whole file larger than the
 * 2 GiB policy cap is refused even when the caller asked for a small range.
 */
export async function readFileRange(
  client: SFTPClient,
  path: string,
  offset: number,
  length?: number,
): Promise<SftpReadRange> {
  if (!Number.isSafeInteger(offset) || offset < 0) throw new SftpOperationError('invalid_range', 'The offset must be a non-negative integer')
  if (length !== undefined && (!Number.isSafeInteger(length) || length < 0)) {
    throw new SftpOperationError('invalid_range', 'The length must be a non-negative integer')
  }
  const attrs = await client.stat(path)
  if (getSftpFileKind(attrs) === 'directory') throw new SftpOperationError('is_directory', 'That path is a directory')
  const size = sftpSize(attrs.size)
  if (size > WEBSSH_SFTP_MAX_FILE_BYTES) throw new SftpOperationError('file_too_large', 'The remote file exceeds the 2 GiB limit')
  if (offset > size) throw new SftpOperationError('invalid_range', 'The offset is past the end of the file')

  const remainingFile = size - offset
  const requested = length === undefined ? Math.min(remainingFile, WEBSSH_SFTP_MAX_BLOCK_BYTES) : length
  if (requested > WEBSSH_SFTP_MAX_BLOCK_BYTES) throw new SftpOperationError('block_too_large', 'A read block may not exceed 64 MiB')
  const toRead = Math.min(requested, remainingFile)

  const handle = await client.openFile(path, 0x00000001)
  const chunks: Uint8Array[] = []
  let position = offset
  let remaining = toRead
  try {
    while (remaining > 0) {
      const block = Math.min(remaining, WEBSSH_SFTP_WIRE_CHUNK_BYTES)
      const data = await client.readFile(handle, position, block)
      if (!data || data.length === 0) break
      chunks.push(data)
      position += data.length
      remaining -= data.length
    }
  } finally {
    await client.closeHandle(handle).catch(() => undefined)
  }
  return { data: concatChunks(chunks), offset, size, attrs }
}

/** Writes exactly `size` bytes from an async chunk source, one 64 KiB SFTP WRITE at a time. */
export async function writeFileChunks(
  client: SFTPClient,
  path: string,
  size: number,
  chunks: AsyncIterable<Uint8Array>,
): Promise<void> {
  if (!Number.isSafeInteger(size) || size < 0) throw new SftpOperationError('invalid_size', 'The upload size is invalid')
  if (size > WEBSSH_SFTP_MAX_FILE_BYTES) throw new SftpOperationError('file_too_large', 'The upload exceeds the 2 GiB limit')
  const handle = await client.openFile(path, 0x00000002 | 0x00000008 | 0x00000010)
  let written = 0
  try {
    for await (const chunk of chunks) {
      let offset = 0
      while (offset < chunk.length) {
        const block = chunk.subarray(offset, offset + WEBSSH_SFTP_WIRE_CHUNK_BYTES)
        if (written + block.length > size) throw new SftpOperationError('size_mismatch', 'The upload is larger than the declared size')
        await client.writeFile(handle, written, block)
        written += block.length
        offset += block.length
      }
    }
    if (written !== size) throw new SftpOperationError('size_mismatch', 'The upload is shorter than the declared size')
    await client.closeHandle(handle)
  } catch (error) {
    await client.closeHandle(handle).catch(() => undefined)
    throw error
  }
}

function concatChunks(chunks: Uint8Array[]): Uint8Array {
  let total = 0
  for (const chunk of chunks) total += chunk.length
  const output = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    output.set(chunk, offset)
    offset += chunk.length
  }
  return output
}
