import { useCallback, useState } from 'react'
import type { CloudDriveEntry } from '@shared/clouddrive/model'
import type { MessageKey } from '@shared/locales/en-US'
import { t } from '../../../lib/i18n'
import { useUi } from '../../../store/ui'
import { CloudDriveApiError, clouddriveApi, cloudDriveErrorKey } from '../api'
import { useTransferStore } from '../transfers/useTransferStore'
import { fetchAndSaveOffline } from '../offline/store'

export type FileListChange =
  | { type: 'remove'; ids: string[] }
  | { type: 'replace'; entry: CloudDriveEntry }

export interface FileActionsOptions {
  mountId: string
  refresh: () => void | Promise<void>
  external?: boolean
  /** Local list updates applied before the refresh confirms them. */
  onLocalChange?: (change: FileListChange) => void
}

export interface ShareOptions {
  password?: string
  expiresDays?: number
  maxViews?: number
  maxDownloads?: number
  allowDownload?: boolean
}

export interface FileActions {
  busy: boolean
  mkdir: (parentPath: string, name: string) => Promise<boolean>
  rename: (entry: CloudDriveEntry, name: string) => Promise<boolean>
  setColor: (entry: CloudDriveEntry, color: string | null) => Promise<boolean>
  setFolderMeta: (entry: CloudDriveEntry, note: string, hiddenPatterns: string[]) => Promise<boolean>
  addTag: (entry: CloudDriveEntry, tag: string, color: string) => Promise<boolean>
  removeTag: (entry: CloudDriveEntry, tag: string) => Promise<boolean>
  move: (ids: string[], toPath: string, entries?: CloudDriveEntry[]) => Promise<boolean>
  copy: (ids: string[], toPath: string) => Promise<boolean>
  trash: (ids: string[], entries?: CloudDriveEntry[]) => Promise<boolean>
  restore: (ids: string[]) => Promise<boolean>
  purge: (ids?: string[], all?: boolean) => Promise<boolean>
  upload: (files: File[], parentPath: string) => Promise<boolean>
  download: (entries: CloudDriveEntry[]) => void
  offline: (entry: CloudDriveEntry) => Promise<boolean>
  share: (entries: CloudDriveEntry[], options?: ShareOptions) => Promise<boolean>
}

function showError(error: unknown): void {
  useUi.getState().toast({ title: t(cloudDriveErrorKey(error) as MessageKey), tone: 'danger' })
}

function showSuccess(message: string): void {
  useUi.getState().toast({ title: message, tone: 'success' })
}

function failedResults(results: unknown[]): number {
  return results.filter((result) => {
    if (!result || typeof result !== 'object') return false
    return (result as { ok?: unknown }).ok === false
  }).length
}

function childPath(parent: string, name: string): string {
  return parent === '/' ? `/${name}` : `${parent}/${name}`
}

function parentPath(path: string): string {
  const index = path.lastIndexOf('/')
  return index <= 0 ? '/' : path.slice(0, index)
}

export function useFileActions({ mountId, refresh, external = false, onLocalChange }: FileActionsOptions): FileActions {
  const [pending, setPending] = useState(0)

  const execute = useCallback(async (work: () => Promise<void>): Promise<boolean> => {
    setPending((count) => count + 1)
    try {
      await work()
    } catch (error) {
      showError(error)
      return false
    } finally {
      setPending((count) => Math.max(0, count - 1))
    }
    try {
      await refresh()
    } catch (error) {
      showError(error)
    }
    return true
  }, [refresh])

  const mkdir = useCallback((parentPathValue: string, name: string) => execute(async () => {
    if (external) await clouddriveApi.externalMkdir(mountId, childPath(parentPathValue, name))
    else await clouddriveApi.mkdir({ mountId, parentPath: parentPathValue, name })
    showSuccess(t('clouddrive.toast.created'))
  }), [execute, external, mountId])

  const rename = useCallback((entry: CloudDriveEntry, name: string) => execute(async () => {
    if (external) {
      await clouddriveApi.externalMove(mountId, entry.path, childPath(parentPath(entry.path), name))
    } else {
      const result = await clouddriveApi.patch(entry.id, { name })
      onLocalChange?.({ type: 'replace', entry: result.entry })
    }
    showSuccess(t('clouddrive.toast.renamed'))
  }), [execute, external, mountId, onLocalChange])

  const setColor = useCallback((entry: CloudDriveEntry, color: string | null) => execute(async () => {
    const result = await clouddriveApi.patch(entry.id, { color })
    onLocalChange?.({ type: 'replace', entry: result.entry })
    showSuccess(t('clouddrive.toast.color_saved'))
  }), [execute, onLocalChange])

  const setFolderMeta = useCallback((entry: CloudDriveEntry, note: string, hiddenPatterns: string[]) => execute(async () => {
    const result = await clouddriveApi.patch(entry.id, { note, hidePatterns: hiddenPatterns })
    onLocalChange?.({ type: 'replace', entry: result.entry })
    showSuccess(t('clouddrive.toast.meta_saved'))
  }), [execute, onLocalChange])

  const addTag = useCallback((entry: CloudDriveEntry, tag: string, color: string) => execute(async () => {
    const result = await clouddriveApi.addTag(entry.id, { tag, color })
    onLocalChange?.({ type: 'replace', entry: result.entry })
    showSuccess(t('clouddrive.toast.tags_saved'))
  }), [execute, onLocalChange])

  const removeTag = useCallback((entry: CloudDriveEntry, tag: string) => execute(async () => {
    const result = await clouddriveApi.removeTag(entry.id, tag)
    onLocalChange?.({ type: 'replace', entry: result.entry })
    showSuccess(t('clouddrive.toast.tags_saved'))
  }), [execute, onLocalChange])

  const move = useCallback((ids: string[], toPath: string, entries?: CloudDriveEntry[]) => execute(async () => {
    if (external) {
      if (!entries || entries.length === 0) throw new CloudDriveApiError('internal', 'missing entries', 0)
      for (const entry of entries) {
        await clouddriveApi.externalMove(mountId, entry.path, childPath(toPath, entry.name))
      }
      onLocalChange?.({ type: 'remove', ids })
    } else {
      const result = await clouddriveApi.move({ ids, toPath, conflict: 'rename' })
      onLocalChange?.({ type: 'remove', ids })
      const failed = failedResults(result.results)
      if (failed > 0) showError(new CloudDriveApiError('internal', 'partial move', 0))
      else showSuccess(t('clouddrive.toast.moved', { count: ids.length }))
      return
    }
    showSuccess(t('clouddrive.toast.moved', { count: entries.length }))
  }), [execute, external, mountId, onLocalChange])

  const copy = useCallback((ids: string[], toPath: string) => execute(async () => {
    const result = await clouddriveApi.copy({ ids, toPath, conflict: 'rename' })
    const failed = failedResults(result.results)
    if (failed > 0) showError(new CloudDriveApiError('internal', 'partial copy', 0))
    else showSuccess(t('clouddrive.toast.copied', { count: ids.length }))
  }), [execute])

  const trash = useCallback((ids: string[], entries?: CloudDriveEntry[]) => execute(async () => {
    if (external) {
      if (!entries || entries.length === 0) throw new CloudDriveApiError('internal', 'missing entries', 0)
      const result = await clouddriveApi.externalDelete(mountId, entries.map((entry) => entry.path))
      onLocalChange?.({ type: 'remove', ids })
      if (result.failed > 0) showError(new CloudDriveApiError('internal', `${result.failed} item(s) could not be deleted`, 0))
      else showSuccess(t('clouddrive.toast.deleted_external', { count: result.deleted }))
      return
    }
    const result = await clouddriveApi.remove(ids)
    onLocalChange?.({ type: 'remove', ids })
    showSuccess(t('clouddrive.toast.deleted', { count: result.deleted || ids.length }))
  }), [execute, external, mountId, onLocalChange])

  const restore = useCallback((ids: string[]) => execute(async () => {
    await clouddriveApi.restore(ids, mountId)
    showSuccess(t('clouddrive.toast.restored', { count: ids.length }))
  }), [execute, mountId])

  const purge = useCallback((ids?: string[], all = false) => execute(async () => {
    const result = await clouddriveApi.purge({ ids, all, mountId })
    if (ids?.length) onLocalChange?.({ type: 'remove', ids })
    showSuccess(t('clouddrive.toast.purged', { count: result.deleted || ids?.length || 0 }))
  }), [execute, onLocalChange, mountId])

  const upload = useCallback(async (files: File[], parentPathValue: string): Promise<boolean> => {
    if (files.length === 0) return true
    if (external) {
      setPending((count) => count + 1)
      try {
        for (const file of files) {
          await clouddriveApi.externalUpload(mountId, childPath(parentPathValue, file.name), file)
        }
        showSuccess(t('clouddrive.toast.uploaded_external', { count: files.length }))
        await refresh()
        return true
      } catch (error) {
        showError(error)
        try { await refresh() } catch (refreshError) { console.warn('[inkstone] CloudDrive refresh after a failed upload failed', refreshError) }
        return false
      } finally {
        setPending((count) => Math.max(0, count - 1))
      }
    }
    useTransferStore.getState().enqueueUpload(files, { mountId, parentPath: parentPathValue })
    showSuccess(t('clouddrive.upload.queued', { count: files.length }))
    return true
  }, [external, mountId, refresh])

  const offline = useCallback(async (entry: CloudDriveEntry): Promise<boolean> => {
    setPending((count) => count + 1)
    try {
      await fetchAndSaveOffline(entry)
      showSuccess(t('clouddrive.offline.saved', { name: entry.name }))
      return true
    } catch (error) {
      const key = error instanceof Error && (error.message === 'offline_too_large' || error.message === 'offline_quota')
        ? `clouddrive.offline.${error.message}`
        : 'clouddrive.offline.save_failed'
      useUi.getState().toast({ title: t(key as MessageKey), tone: 'danger' })
      return false
    } finally {
      setPending((count) => Math.max(0, count - 1))
    }
  }, [])

  const download = useCallback((entries: CloudDriveEntry[]) => {
    for (const entry of entries) {
      const href = entry.kind === 'folder'
        ? clouddriveApi.zipUrl({ mountId, path: entry.path })
        : clouddriveApi.contentUrl(entry.id, true)
      const anchor = document.createElement('a')
      anchor.href = href
      anchor.rel = 'noopener'
      document.body.append(anchor)
      anchor.click()
      anchor.remove()
    }
  }, [mountId])

  const share = useCallback(async (entries: CloudDriveEntry[], options: ShareOptions = {}): Promise<boolean> => {
    if (entries.length === 0) return false
    setPending((count) => count + 1)
    try {
      const urls: string[] = []
      const expiresAt = options.expiresDays && options.expiresDays > 0
        ? Date.now() + options.expiresDays * 86_400_000
        : undefined
      for (const entry of entries) {
        const result = await clouddriveApi.createShare({
          targetKind: entry.kind === 'folder' ? 'folder' : 'file',
          fileId: entry.id,
          mountId,
          path: entry.path,
          password: options.password || undefined,
          expiresAt,
          maxViews: options.maxViews && options.maxViews > 0 ? options.maxViews : undefined,
          maxDownloads: options.maxDownloads && options.maxDownloads > 0 ? options.maxDownloads : undefined,
          allowDownload: options.allowDownload !== false,
          allowList: entry.kind === 'folder',
        })
        const url = result.share.url.startsWith('http')
          ? result.share.url
          : new URL(result.share.url, window.location.origin).toString()
        urls.push(url)
      }
      if (!navigator.clipboard) throw new CloudDriveApiError('internal', 'clipboard unavailable', 0)
      await navigator.clipboard.writeText(urls.join('\n'))
      showSuccess(t('clouddrive.toast.copied_link'))
      return true
    } catch (error) {
      showError(error)
      return false
    } finally {
      setPending((count) => Math.max(0, count - 1))
    }
  }, [mountId])

  return {
    busy: pending > 0,
    mkdir,
    rename,
    setColor,
    setFolderMeta,
    addTag,
    removeTag,
    move,
    copy,
    trash,
    restore,
    purge,
    upload,
    download,
    offline,
    share,
  }
}
