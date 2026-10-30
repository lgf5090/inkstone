import { CLIENT_HEADER } from '@shared/constants'
import { CloudDriveApiError, clouddriveApi } from '../api'
import { MIRROR_DEFAULTS, parentOf, planMirror, type MirrorLocalFile, type MirrorOptions, type MirrorPlan, type MirrorRemoteEntry } from './plan'

export interface CollectedMirror {
  folders: string[]
  files: (MirrorLocalFile & { handle: FileSystemFileHandle })[]
  truncated: boolean
}

export interface MirrorProgress {
  phase: 'collect' | 'compare' | 'folders' | 'upload'
  done: number
  total: number
  current: string | null
  failed: number
}

interface DirectoryPickerWindow {
  showDirectoryPicker?: (options?: { mode?: 'read' | 'readwrite' }) => Promise<FileSystemDirectoryHandle>
}

export function directoryPickerAvailable(): boolean {
  return typeof window !== 'undefined' && typeof (window as unknown as DirectoryPickerWindow).showDirectoryPicker === 'function'
}

export async function pickMirrorDirectory(): Promise<FileSystemDirectoryHandle | null> {
  const picker = (window as unknown as DirectoryPickerWindow).showDirectoryPicker
  if (!picker) return null
  return await picker.call(window, { mode: 'read' })
}

export async function collectMirror(
  directory: FileSystemDirectoryHandle,
  options: MirrorOptions = MIRROR_DEFAULTS,
): Promise<CollectedMirror> {
  const collected: CollectedMirror = { folders: [], files: [], truncated: false }
  const maxEntries = 50_000
  const walk = async (handle: FileSystemDirectoryHandle, prefix: string, level: number): Promise<void> => {
    if (level > 32 || collected.truncated) return
    const entries = (handle as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }).entries()
    for await (const [name, child] of entries) {
      if (name === '.' || name === '..') continue
      const path = prefix ? `${prefix}/${name}` : name
      if (child.kind === 'directory') {
        if (!options.includeHidden && name.startsWith('.')) continue
        collected.folders.push(path)
        await walk(child as FileSystemDirectoryHandle, path, level + 1)
      } else {
        if (collected.files.length >= maxEntries) {
          collected.truncated = true
          return
        }
        const file = await (child as FileSystemFileHandle).getFile()
        collected.files.push({ path, size: file.size, lastModified: file.lastModified, handle: child as FileSystemFileHandle })
      }
    }
  }
  await walk(directory, '', 0)
  return collected
}

async function putBytes(url: string, body: Blob): Promise<void> {
  const response = await fetch(url, {
    method: 'PUT',
    body,
    credentials: 'same-origin',
    headers: { [CLIENT_HEADER]: '1', 'Content-Type': 'application/octet-stream' },
  })
  if (response.ok) return
  const payload = await response.json().catch(() => null) as { error?: { code?: string; message?: string } } | null
  throw new CloudDriveApiError(
    payload?.error?.code ?? 'internal',
    payload?.error?.message ?? response.statusText,
    response.status,
  )
}

export function remotePath(base: string, relative: string): string {
  const left = base === '/' ? '' : base.replace(/\/+$/, '')
  const right = relative.replace(/^\/+|\/+$/g, '')
  return [left, right].filter(Boolean).join('/') || '/'
}

async function ensureFolder(mountId: string, folderPath: string, ensured: Set<string>): Promise<void> {
  const segments = folderPath.split('/').filter(Boolean)
  let current = '/'
  for (const segment of segments) {
    const next = remotePath(current, segment)
    if (!ensured.has(next)) {
      try {
        await clouddriveApi.mkdir({ mountId, parentPath: current, name: segment })
      } catch (error) {
        const conflict = error instanceof CloudDriveApiError
          && (error.status === 409 || error.code === 'clouddrive_conflict')
        if (!conflict) throw error
      }
      ensured.add(next)
    }
    current = next
  }
}

export interface MirrorRunOptions {
  mountId: string
  remoteBase: string
  directory: FileSystemDirectoryHandle
  options?: MirrorOptions
  onProgress?: (progress: MirrorProgress) => void
}

export interface MirrorRunResult {
  plan: MirrorPlan
  uploaded: number
  failed: { path: string; message: string }[]
  truncated: boolean
}

export async function runMirror({
  mountId,
  remoteBase,
  directory,
  options = MIRROR_DEFAULTS,
  onProgress,
}: MirrorRunOptions): Promise<MirrorRunResult> {
  onProgress?.({ phase: 'collect', done: 0, total: 0, current: null, failed: 0 })
  const collected = await collectMirror(directory, options)
  onProgress?.({ phase: 'compare', done: 0, total: collected.files.length, current: null, failed: 0 })
  const remote = await clouddriveApi.listRemote({ mountId, path: remoteBase })
  const plan = planMirror(collected.folders, collected.files, remote.entries as MirrorRemoteEntry[], options)

  const ensured = new Set<string>()
  await ensureFolder(mountId, remoteBase, ensured)
  let folderDone = 0
  for (const folder of plan.folders) {
    await ensureFolder(mountId, remotePath(remoteBase, folder), ensured)
    folderDone += 1
    onProgress?.({
      phase: 'folders',
      done: folderDone,
      total: plan.folders.length,
      current: folder,
      failed: 0,
    })
  }

  const failed: { path: string; message: string }[] = []
  let uploaded = 0
  for (const planned of plan.uploads) {
    const handle = collected.files.find((file) => file.path === planned.path)?.handle
    if (!handle) {
      failed.push({ path: planned.path, message: 'The local file is no longer available' })
      continue
    }
    onProgress?.({
      phase: 'upload',
      done: uploaded,
      total: plan.uploads.length,
      current: planned.path,
      failed: failed.length,
    })
    try {
      const file = await handle.getFile()
      const init = await clouddriveApi.initUpload({
        mountId,
        parentPath: remotePath(remoteBase, parentOf(planned.path)),
        name: planned.path.split('/').pop() ?? planned.path,
        size: file.size,
        mime: file.type || 'application/octet-stream',
        conflict: 'overwrite',
      })
      if (init.session.strategy === 'direct') {
        await putBytes(`/api/clouddrive/uploads/${encodeURIComponent(init.session.id)}/content`, file)
      } else {
        const { partSize, totalParts } = init.session
        for (let part = 1; part <= totalParts; part += 1) {
          const start = (part - 1) * partSize
          const chunk = file.slice(start, Math.min(file.size, start + partSize))
          await putBytes(`/api/clouddrive/uploads/${encodeURIComponent(init.session.id)}/parts/${part}`, chunk)
        }
      }
      await clouddriveApi.completeUpload(init.session.id)
      uploaded += 1
    } catch (error) {
      failed.push({ path: planned.path, message: error instanceof Error ? error.message : String(error) })
    }
  }
  onProgress?.({
    phase: 'upload',
    done: uploaded,
    total: plan.uploads.length,
    current: null,
    failed: failed.length,
  })
  return { plan, uploaded, failed, truncated: collected.truncated || remote.truncated }
}
