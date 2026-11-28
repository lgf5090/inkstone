// @vitest-environment node
import { strToU8, unzipSync } from 'fflate'
import { describe, expect, it, vi } from 'vitest'
import { createProjectArchiveDownload, type ProjectArchiveEntry } from '../src/worker/project/archive-export'
import { testR2Bucket } from './doubles/bindings'

const limits = { maxFiles: 100, maxBytes: 32 * 1024 * 1024, maxUncompressedBytes: 64 * 1024 * 1024 }

async function* repeatedChunks(totalBytes: number, chunkBytes = 64 * 1024): AsyncGenerator<Uint8Array> {
  let state = 0x12345678
  for (let sent = 0; sent < totalBytes; sent += chunkBytes) {
    const chunk = new Uint8Array(Math.min(chunkBytes, totalBytes - sent))
    for (let index = 0; index < chunk.byteLength; index += 1) {
      state ^= state << 13
      state ^= state >>> 17
      state ^= state << 5
      chunk[index] = state
    }
    yield chunk
  }
}

function entry(name: string, totalBytes: number): ProjectArchiveEntry {
  return { name, chunks: repeatedChunks(totalBytes) }
}

describe('streaming project archive upload', () => {
  it('uploads bounded multipart chunks and removes the completed temporary object after download', async () => {
    const files = testR2Bucket()
    const createMultipartUpload = files.createMultipartUpload.bind(files)
    const partSizes: number[] = []
    vi.spyOn(files, 'createMultipartUpload').mockImplementation(async (key, options) => {
      const upload = await createMultipartUpload(key, options)
      const uploadPart = upload.uploadPart.bind(upload)
      upload.uploadPart = async (partNumber, value) => {
        partSizes.push(value instanceof Uint8Array ? value.byteLength : (await new Response(value as BodyInit).arrayBuffer()).byteLength)
        return uploadPart(partNumber, value)
      }
      return upload
    })
    async function* entries(): AsyncGenerator<ProjectArchiveEntry> {
      yield { name: 'version.json', chunks: (async function* () { yield strToU8('{"version":3}') })() }
      yield entry('large.bin', 12 * 1024 * 1024)
    }
    const archive = await createProjectArchiveDownload(files, entries(), limits)
    expect(partSizes.length).toBeGreaterThanOrEqual(3)
    expect(Math.max(...partSizes)).toBeLessThan(6 * 1024 * 1024)
    expect(partSizes.slice(0, -1).every((size) => size >= 5 * 1024 * 1024)).toBe(true)
    const bytes = new Uint8Array(await new Response(archive.body).arrayBuffer())
    expect(bytes.byteLength).toBe(archive.size)
    expect(unzipSync(bytes)['large.bin']).toHaveLength(12 * 1024 * 1024)
    expect([...files.objects.keys()].some((key) => key.startsWith('project/exports/'))).toBe(false)
  })

  it('aborts without publishing an object when the output budget is exceeded', async () => {
    const files = testR2Bucket()
    const createMultipartUpload = files.createMultipartUpload.bind(files)
    let aborts = 0
    vi.spyOn(files, 'createMultipartUpload').mockImplementation(async (key, options) => {
      const upload = await createMultipartUpload(key, options)
      const abort = upload.abort.bind(upload)
      upload.abort = async () => { aborts += 1; await abort() }
      return upload
    })
    async function* entries(): AsyncGenerator<ProjectArchiveEntry> {
      yield entry('large.bin', 2 * 1024 * 1024)
    }
    await expect(createProjectArchiveDownload(files, entries(), { ...limits, maxBytes: 1024 })).rejects.toMatchObject({ status: 413 })
    expect(aborts).toBe(1)
    expect(files.objects.size).toBe(0)
  })

  it('cleans up the temporary object when the download is cancelled', async () => {
    const files = testR2Bucket()
    async function* entries(): AsyncGenerator<ProjectArchiveEntry> {
      yield { name: 'version.json', chunks: (async function* () { yield strToU8('{"version":3}') })() }
    }
    const archive = await createProjectArchiveDownload(files, entries(), limits)
    expect([...files.objects.keys()].filter((key) => key.startsWith('project/exports/'))).toHaveLength(1)
    const reader = archive.body.getReader()
    expect((await reader.read()).done).toBe(false)
    await reader.cancel()
    expect(files.objects.size).toBe(0)
  })
})
