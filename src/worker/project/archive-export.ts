import { Zip, ZipDeflate } from 'fflate'
import { ApiError } from '../lib/errors'

const ARCHIVE_CHUNK_BYTES = 256 * 1024
const ARCHIVE_PART_BYTES = 5 * 1024 * 1024

export interface ProjectArchiveWriteLimits {
  maxFiles: number
  maxBytes: number
  maxUncompressedBytes: number
}

export interface ProjectArchiveEntry {
  name: string
  chunks: AsyncIterable<Uint8Array>
}

export interface ProjectArchiveDownload {
  body: ReadableStream<Uint8Array>
  size: number
}

interface PendingUpload {
  upload: R2MultipartUpload
  parts: { partNumber: number, etag: string }[]
  partChunks: Uint8Array[]
  partBytes: number
  nextPart: number
}

async function* boundedChunks(chunks: AsyncIterable<Uint8Array>): AsyncGenerator<Uint8Array> {
  for await (const chunk of chunks) {
    for (let offset = 0; offset < chunk.byteLength; offset += ARCHIVE_CHUNK_BYTES) {
      yield chunk.subarray(offset, Math.min(offset + ARCHIVE_CHUNK_BYTES, chunk.byteLength))
    }
  }
}

async function flushPart(pending: PendingUpload): Promise<void> {
  if (!pending.partBytes) return
  const bytes = new Uint8Array(pending.partBytes)
  let offset = 0
  for (const chunk of pending.partChunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  const part = await pending.upload.uploadPart(pending.nextPart, bytes)
  pending.parts.push(part)
  pending.nextPart += 1
  pending.partChunks = []
  pending.partBytes = 0
}

function downloadableObject(r2: R2Bucket, key: string, object: R2ObjectBody, size: number): ProjectArchiveDownload {
  const reader = object.body.getReader()
  let released = false
  let cleaned = false
  const cleanup = async (): Promise<void> => {
    if (cleaned) return
    if (!released) {
      reader.releaseLock()
      released = true
    }
    await r2.delete(key)
    cleaned = true
  }
  return {
    size,
    body: new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const result = await reader.read()
          if (result.done) {
            await cleanup()
            controller.close()
          } else {
            controller.enqueue(result.value)
          }
        } catch (error) {
          try {
            await cleanup()
          } catch (cleanupError) {
            console.warn('[inkstone] project archive cleanup failed:', cleanupError instanceof Error ? cleanupError.message : cleanupError)
          }
          controller.error(error)
        }
      },
      async cancel(reason) {
        let cancelError: unknown
        try {
          await reader.cancel(reason)
        } catch (error) {
          cancelError = error
        }
        try {
          await cleanup()
        } catch (cleanupError) {
          console.warn('[inkstone] project archive cleanup failed:', cleanupError instanceof Error ? cleanupError.message : cleanupError)
        }
        if (cancelError !== undefined) throw cancelError
      },
    }),
  }
}

export async function createProjectArchiveDownload(
  r2: R2Bucket,
  entries: AsyncIterable<ProjectArchiveEntry>,
  limits: ProjectArchiveWriteLimits,
): Promise<ProjectArchiveDownload> {
  const key = `project/exports/${crypto.randomUUID()}.zip`
  const upload = await r2.createMultipartUpload(key, { httpMetadata: { contentType: 'application/zip' } })
  const pending: PendingUpload = { upload, parts: [], partChunks: [], partBytes: 0, nextPart: 1 }
  const zip = new Zip((error, chunk) => {
    if (error) throw error
    if (!chunk) return
    pending.partChunks.push(chunk)
    pending.partBytes += chunk.byteLength
  })
  let completed = false
  let files = 0
  let written = 0
  let uncompressed = 0
  const flushOutput = async (): Promise<void> => {
    if (written + pending.partBytes > limits.maxBytes) throw ApiError.tooLarge('Archive is too large')
    if (pending.partBytes >= ARCHIVE_PART_BYTES) {
      const size = pending.partBytes
      await flushPart(pending)
      written += size
    }
  }
  const flushFinal = async (): Promise<void> => {
    if (written + pending.partBytes > limits.maxBytes) throw ApiError.tooLarge('Archive is too large')
    while (pending.partBytes) {
      const size = pending.partBytes
      await flushPart(pending)
      written += size
    }
  }
  try {
    for await (const entry of entries) {
      files += 1
      if (files > limits.maxFiles) throw ApiError.tooLarge('Archive has too many files')
      const file = new ZipDeflate(entry.name)
      zip.add(file)
      await flushOutput()
      for await (const chunk of boundedChunks(entry.chunks)) {
        uncompressed += chunk.byteLength
        if (uncompressed > limits.maxUncompressedBytes) throw ApiError.tooLarge('Archive expands beyond the allowed size')
        file.push(chunk)
        await flushOutput()
      }
      file.push(new Uint8Array(), true)
      await flushOutput()
    }
    zip.end()
    await flushFinal()
    if (!pending.parts.length) throw new Error('Archive upload produced no parts')
    await upload.complete(pending.parts)
    completed = true
    const object = await r2.get(key)
    if (!object || object.size !== written) {
      if (object) await r2.delete(key)
      throw new Error('Archive upload size does not match the generated bytes')
    }
    return downloadableObject(r2, key, object, written)
  } catch (error) {
    if (!completed) {
      try {
        await upload.abort()
      } catch (cleanupError) {
        console.warn('[inkstone] project archive upload cleanup failed:', cleanupError instanceof Error ? cleanupError.message : cleanupError)
      }
    }
    try {
      await r2.delete(key)
    } catch (cleanupError) {
      console.warn('[inkstone] project archive object cleanup failed:', cleanupError instanceof Error ? cleanupError.message : cleanupError)
    }
    throw error
  }
}
