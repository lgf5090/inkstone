import { useCallback, useRef, useState } from 'react'
import { ApiError } from '../../lib/api'
import { websshApi } from './api'

export const SFTP_UPLOAD_CONCURRENCY = 4

export interface UploadCandidate {
  file: File
  relativePath: string
}

export type TransferStatus = 'queued' | 'uploading' | 'done' | 'cancelled' | 'error'

export interface TransferJob {
  id: string
  name: string
  relativePath: string
  remotePath: string
  size: number
  uploaded: number
  status: TransferStatus
  error: string
}

export interface TransferSummary {
  active: number
  queued: number
  totalBytes: number
  uploadedBytes: number
  failed: number
}

function joinPath(parent: string, name: string): string {
  if (parent === '/') return `/${name}`
  return `${parent.replace(/\/+$/, '')}/${name}`
}

function errorText(caught: unknown): string {
  if (caught instanceof ApiError) return caught.message
  if (caught instanceof Error && caught.message) return caught.message
  return 'The upload failed'
}

export function candidatesFromFileInput(files: FileList | null): UploadCandidate[] {
  if (!files) return []
  return Array.from(files).map((file) => ({
    file,
    relativePath: file.webkitRelativePath && file.webkitRelativePath.length > 0 ? file.webkitRelativePath : file.name,
  }))
}

async function readEntries(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  const entries: FileSystemEntry[] = []
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => {
      reader.readEntries(resolve, reject)
    })
    if (batch.length === 0) return entries
    entries.push(...batch)
  }
}

async function walkEntry(entry: FileSystemEntry, prefix: string, output: UploadCandidate[]): Promise<void> {
  if (entry.isFile) {
    const file = await new Promise<File>((resolve, reject) => {
      (entry as FileSystemFileEntry).file(resolve, reject)
    })
    output.push({ file, relativePath: prefix ? `${prefix}/${file.name}` : file.name })
    return
  }
  if (!entry.isDirectory) return
  const reader = (entry as FileSystemDirectoryEntry).createReader()
  const children = await readEntries(reader)
  const next = prefix ? `${prefix}/${entry.name}` : entry.name
  for (const child of children) await walkEntry(child, next, output)
}

export async function collectDropCandidates(transfer: DataTransfer): Promise<UploadCandidate[]> {
  const output: UploadCandidate[] = []
  const items = Array.from(transfer.items ?? [])
  const entries = items
    .map((item) => item.webkitGetAsEntry?.() ?? null)
    .filter((entry): entry is FileSystemEntry => entry !== null)
  if (entries.length > 0) {
    for (const entry of entries) await walkEntry(entry, '', output)
    return output
  }
  for (const file of Array.from(transfer.files ?? [])) {
    output.push({
      file,
      relativePath: file.webkitRelativePath && file.webkitRelativePath.length > 0 ? file.webkitRelativePath : file.name,
    })
  }
  return output
}

export function useSftpTransfers(sessionId: string, onFinished: () => void) {
  const [jobs, setJobs] = useState<TransferJob[]>([])
  const cancelled = useRef(new Set<string>())
  const queue = useRef<TransferJobInput[]>([])
  const active = useRef(0)
  const finishedRef = useRef(onFinished)
  finishedRef.current = onFinished

  const updateJob = useCallback((id: string, patch: Partial<TransferJob>) => {
    setJobs((current) => current.map((job) => (job.id === id ? { ...job, ...patch } : job)))
  }, [])

  const runJob = useCallback(async (job: TransferJobInput) => {
    if (cancelled.current.has(job.id)) {
      updateJob(job.id, { status: 'cancelled' })
      return
    }
    updateJob(job.id, { status: 'uploading' })
    let transferId = ''
    try {
      const created = await websshApi.createUpload(sessionId, job.remotePath, job.size)
      transferId = created.transferId
      let offset = 0
      while (offset < job.size) {
        if (cancelled.current.has(job.id)) {
          await websshApi.cancelUpload(sessionId, transferId).catch((error: unknown) => {
            console.warn('[inkstone] Could not cancel staged upload:', error)
          })
          updateJob(job.id, { status: 'cancelled' })
          return
        }
        const chunk = job.file.slice(offset, Math.min(offset + created.chunkSize, job.size))
        await websshApi.putChunk(sessionId, transferId, offset, chunk)
        offset += chunk.size
        updateJob(job.id, { uploaded: offset })
      }
      await websshApi.completeUpload(sessionId, transferId)
      updateJob(job.id, { status: 'done', uploaded: job.size })
      finishedRef.current()
    } catch (caught) {
      if (transferId) {
        await websshApi.cancelUpload(sessionId, transferId).catch(() => undefined)
      }
      if (cancelled.current.has(job.id)) {
        updateJob(job.id, { status: 'cancelled' })
        return
      }
      updateJob(job.id, { status: 'error', error: errorText(caught) })
    }
  }, [sessionId, updateJob])

  const pump = useCallback(() => {
    while (active.current < SFTP_UPLOAD_CONCURRENCY && queue.current.length > 0) {
      const job = queue.current.shift()
      if (!job) break
      active.current += 1
      void runJob(job).finally(() => {
        active.current -= 1
        pump()
      })
    }
  }, [runJob])

  const enqueue = useCallback(async (candidates: UploadCandidate[], targetDir: string) => {
    if (candidates.length === 0) return
    const directories = new Set<string>()
    for (const candidate of candidates) {
      const parts = candidate.relativePath.split('/').filter(Boolean)
      parts.pop()
      let current = targetDir
      for (const part of parts) {
        current = joinPath(current, part)
        directories.add(current)
      }
    }
    for (const directory of [...directories].sort((left, right) => left.split('/').length - right.split('/').length)) {
      try {
        await websshApi.listDir(sessionId, directory)
      } catch {
        await websshApi.mkdir(sessionId, directory).catch(() => undefined)
      }
    }
    const next = candidates.map((candidate) => ({
      id: typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      name: candidate.file.name,
      relativePath: candidate.relativePath,
      remotePath: joinPath(targetDir, candidate.relativePath),
      size: candidate.file.size,
      uploaded: 0,
      status: 'queued' as const,
      error: '',
      file: candidate.file,
    }))
    setJobs((current) => [
      ...next.map((job) => ({
        id: job.id,
        name: job.name,
        relativePath: job.relativePath,
        remotePath: job.remotePath,
        size: job.size,
        uploaded: job.uploaded,
        status: job.status,
        error: job.error,
      })),
      ...current,
    ].slice(0, 200))
    queue.current.push(...next)
    pump()
  }, [pump, sessionId])

  const cancel = useCallback((id: string) => {
    cancelled.current.add(id)
    const index = queue.current.findIndex((job) => job.id === id)
    if (index >= 0) {
      queue.current.splice(index, 1)
      updateJob(id, { status: 'cancelled' })
    }
  }, [updateJob])

  const cancelAll = useCallback(() => {
    for (const job of queue.current) {
      cancelled.current.add(job.id)
      updateJob(job.id, { status: 'cancelled' })
    }
    queue.current = []
    setJobs((current) => current.map((job) => (
      job.status === 'queued' || job.status === 'uploading' ? { ...job, status: 'cancelled' } : job
    )))
  }, [updateJob])

  const clearFinished = useCallback(() => {
    setJobs((current) => current.filter((job) => job.status === 'queued' || job.status === 'uploading'))
  }, [])

  const summary: TransferSummary = {
    active: jobs.filter((job) => job.status === 'uploading').length,
    queued: jobs.filter((job) => job.status === 'queued').length,
    totalBytes: jobs.reduce((total, job) => total + job.size, 0),
    uploadedBytes: jobs.reduce((total, job) => total + job.uploaded, 0),
    failed: jobs.filter((job) => job.status === 'error').length,
  }

  return { jobs, summary, enqueue, cancel, cancelAll, clearFinished }
}

interface TransferJobInput {
  id: string
  name: string
  relativePath: string
  remotePath: string
  size: number
  uploaded: number
  status: TransferStatus
  error: string
  file: File
}
