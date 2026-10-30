import { foldedName } from '@shared/clouddrive/model'

export interface MirrorLocalFile {
  path: string
  size: number
  lastModified: number
}

export interface MirrorRemoteEntry {
  path: string
  kind: 'file' | 'folder'
  size: number
  modifiedAt: number
}

export interface MirrorOptions {
  includeHidden: boolean
  maxFiles: number
  maxBytes: number
  maxFileBytes: number
}

export interface MirrorSkip {
  path: string
  reason: 'hidden' | 'too_large' | 'over_limit' | 'conflict'
}

export interface MirrorPlan {
  folders: string[]
  uploads: MirrorLocalFile[]
  unchanged: number
  skipped: MirrorSkip[]
  bytes: number
}

export const MIRROR_DEFAULTS: MirrorOptions = {
  includeHidden: false,
  maxFiles: 2000,
  maxBytes: 2 * 1024 * 1024 * 1024,
  maxFileBytes: 512 * 1024 * 1024,
}

export function parentOf(path: string): string {
  const index = path.lastIndexOf('/')
  return index < 0 ? '' : path.slice(0, index)
}

function depth(path: string): number {
  return path.split('/').filter(Boolean).length
}

export function planMirror(
  localFolders: readonly string[],
  localFiles: readonly MirrorLocalFile[],
  remote: readonly MirrorRemoteEntry[],
  options: MirrorOptions = MIRROR_DEFAULTS,
): MirrorPlan {
  const remoteFiles = new Map<string, MirrorRemoteEntry>()
  const remoteFolders = new Set<string>()
  for (const entry of remote) {
    const key = foldedName(entry.path)
    if (entry.kind === 'folder') remoteFolders.add(key)
    else remoteFiles.set(key, entry)
  }

  const skipped: MirrorSkip[] = []
  const plan: MirrorPlan = { folders: [], uploads: [], unchanged: 0, skipped, bytes: 0 }
  const foldersToCreate = new Set<string>()

  const hiddenPath = (path: string) => path.split('/').some((segment) => segment.startsWith('.'))
  const considerFolder = (path: string) => {
    if (!path) return
    if (!options.includeHidden && hiddenPath(path)) return
    if (!remoteFolders.has(foldedName(path))) foldersToCreate.add(path)
  }

  for (const folder of [...localFolders].sort((left, right) => depth(left) - depth(right))) {
    if (!options.includeHidden && hiddenPath(folder)) continue
    let current = folder
    while (current) {
      considerFolder(current)
      current = parentOf(current)
    }
  }

  for (const file of localFiles) {
    if (!options.includeHidden && hiddenPath(file.path)) {
      skipped.push({ path: file.path, reason: 'hidden' })
      continue
    }
    if (file.size > options.maxFileBytes) {
      skipped.push({ path: file.path, reason: 'too_large' })
      continue
    }
    const remoteFolder = foldedName(parentOf(file.path))
    if (remoteFolder && remoteFiles.has(remoteFolder)) {
      skipped.push({ path: file.path, reason: 'conflict' })
      continue
    }
    if (remoteFolders.has(foldedName(file.path))) {
      skipped.push({ path: file.path, reason: 'conflict' })
      continue
    }
    const existing = remoteFiles.get(foldedName(file.path))
    if (existing) {
      if (existing.size === file.size && file.lastModified <= existing.modifiedAt + 2000) {
        plan.unchanged += 1
        continue
      }
    }
    if (plan.uploads.length >= options.maxFiles) {
      skipped.push({ path: file.path, reason: 'over_limit' })
      continue
    }
    if (plan.bytes + file.size > options.maxBytes) {
      skipped.push({ path: file.path, reason: 'over_limit' })
      continue
    }
    plan.uploads.push(file)
    plan.bytes += file.size
    let current = parentOf(file.path)
    while (current) {
      considerFolder(current)
      current = parentOf(current)
    }
  }

  plan.folders = [...foldersToCreate].sort((left, right) => depth(left) - depth(right))
  return plan
}
