import { useCallback, useEffect, useRef, useState } from 'react'
import type { HubAttachmentSort, HubAttachmentStats, HubAttachmentWithUsage, AttachmentHubScope } from '@shared/attachment-hub'
import type { MessageKey } from '@shared/locales/en-US'
import { t } from '../../../lib/i18n'
import { formatBytes } from '../../../lib/time'
import { useUi, type ToastInput } from '../../../store/ui'
import { confirm } from '../../../components/overlay'
import { attachmentHubApi } from '../api'
import { useHubOrganizer } from '../attachment-store'
import { useHubScope } from '../hub-scope'
import {
  HUB_LIST_LIMIT,
  categoryFilters,
  type HubCategory,
  type HubSizeFilter,
} from '../attachment-helpers'
import { downloadFile } from '../attachment-item-common'

type Setter<T> = React.Dispatch<React.SetStateAction<T>>
type ToastFn = (input: ToastInput) => void

function failed(toast: ToastFn, titleKey: MessageKey): void {
  toast({ title: t(titleKey), tone: 'danger' })
}

function useHubFilters() {
  const [category, setCategory] = useState<HubCategory>('all')
  const [folderId, setFolderId] = useState<string | null>(null)
  const [tag, setTag] = useState<string | null>(null)
  const [extension, setExtension] = useState('all')
  const [search, setSearch] = useState('')
  const [sizeRange, setSizeRange] = useState<HubSizeFilter>('all')
  const [sort, setSort] = useState<HubAttachmentSort>('date_desc')
  return { category, setCategory, folderId, setFolderId, tag, setTag, extension, setExtension, search, setSearch, sizeRange, setSizeRange, sort, setSort }
}

type HubFilters = ReturnType<typeof useHubFilters>

function useHubView() {
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid')
  const [zoom, setZoom] = useState<'sm' | 'md' | 'lg'>('md')
  return { viewMode, setViewMode, zoom, setZoom }
}

function useHubFiles(open: boolean, scope: AttachmentHubScope, filters: HubFilters, toast: ToastFn) {
  const [files, setFiles] = useState<HubAttachmentWithUsage[]>([])
  const [stats, setStats] = useState<HubAttachmentStats | undefined>(undefined)
  const [isLoading, setIsLoading] = useState(false)
  const [isPruning, setIsPruning] = useState(false)
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [isLoadingMore, setIsLoadingMore] = useState(false)

  const loadFiles = useCallback(async () => {
    setIsLoading(true)
    try {
      const result = await attachmentHubApi.list(scope, {
        ...categoryFilters(filters.category),
        folderId: filters.folderId ?? undefined,
        extension: filters.extension !== 'all' ? filters.extension : undefined,
        sizeRange: filters.sizeRange !== 'all' ? filters.sizeRange : undefined,
        tag: filters.tag ?? undefined,
        search: filters.search.trim() || undefined,
        sort: filters.sort,
        limit: HUB_LIST_LIMIT,
      })
      setFiles(result.files)
      setStats(result.stats)
      setNextCursor(result.nextCursor)
    }
    catch {
      failed(toast, 'attachments.load_failed')
    }
    finally {
      setIsLoading(false)
    }
  }, [scope, filters.category, filters.folderId, filters.tag, filters.extension, filters.search, filters.sizeRange, filters.sort, toast])

  /**
   * The next page, appended rather than swapped in.
   *
   * The server caps a page at 500 and hands back an opaque position marker; without this the
   * centre would silently stop at the first 500 files for anyone with more, and the count in the
   * footer would disagree with the grid in a way that reads as "my files disappeared".
   */
  const loadMore = useCallback(async () => {
    if (!nextCursor || isLoadingMore) return
    setIsLoadingMore(true)
    try {
      const result = await attachmentHubApi.list(scope, {
        ...categoryFilters(filters.category),
        folderId: filters.folderId ?? undefined,
        extension: filters.extension !== 'all' ? filters.extension : undefined,
        sizeRange: filters.sizeRange !== 'all' ? filters.sizeRange : undefined,
        tag: filters.tag ?? undefined,
        search: filters.search.trim() || undefined,
        sort: filters.sort,
        limit: HUB_LIST_LIMIT,
        cursor: nextCursor,
      })
      setFiles((previous) => {
        const seen = new Set(previous.map((file) => file.id))
        return [...previous, ...result.files.filter((file) => !seen.has(file.id))]
      })
      setNextCursor(result.nextCursor)
    }
    catch {
      failed(toast, 'attachments.load_failed')
    }
    finally {
      setIsLoadingMore(false)
    }
  }, [scope, nextCursor, isLoadingMore, filters, toast])

  useEffect(() => {
    if (open) void loadFiles()
  }, [open, loadFiles])

  const uploadFiles = useCallback(async (uploadList: FileList | File[]) => {
    const fileArray = Array.from(uploadList)
    if (fileArray.length === 0) return
    setIsLoading(true)
    let uploaded = 0
    let refused = 0
    for (const file of fileArray) {
      try {
        await attachmentHubApi.upload(scope, file, filters.folderId ?? undefined)
        uploaded += 1
      }
      catch {
        refused += 1
      }
    }
    if (uploaded) void loadFiles()
    toast(refused
      ? { title: t('attachments.upload_failed_value0', { value0: refused }), tone: 'danger' }
      : { title: t('attachments.uploaded_value0', { value0: uploaded }), tone: 'success' })
    setIsLoading(false)
  }, [scope, filters.folderId, loadFiles, toast])

  const prune = useCallback(async () => {
    const ok = await confirm({
      title: t('attachments.cleanup_confirm'),
      description: t('attachments.cleanup_confirm_description'),
      confirmLabel: t('attachments.cleanup'),
      tone: 'danger',
    })
    if (!ok) return
    setIsPruning(true)
    try {
      const result = await attachmentHubApi.prune(scope)
      if (!result.supported) {
        toast({ title: t('attachments.prune_unsupported'), tone: 'warning' })
      }
      else if (result.removed > 0) {
        toast({
          title: t('attachments.cleaned_value0', { value0: result.removed }),
          description: result.freedBytes
            ? t('attachments.freed_value0', { value0: formatBytes(result.freedBytes) })
            : undefined,
          tone: 'success',
        })
        await loadFiles()
      }
      else {
        toast({ title: t('attachments.nothing_to_clean'), tone: 'default' })
      }
    }
    catch {
      failed(toast, 'attachments.cleanup_failed')
    }
    finally {
      setIsPruning(false)
    }
  }, [scope, loadFiles, toast])

  return { files, setFiles, stats, isLoading, isPruning, loadFiles, uploadFiles, prune, nextCursor, isLoadingMore, loadMore }
}

function useHubSelection(open: boolean, files: HubAttachmentWithUsage[]) {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [activeFile, setActiveFile] = useState<HubAttachmentWithUsage | null>(null)

  useEffect(() => {
    if (!open) {
      setSelectedIds(new Set())
      setActiveFile(null)
    }
  }, [open])

  const handleToggleSelect = (id: string, e: React.MouseEvent) => {
    e.stopPropagation()
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const handleToggleSelectAll = () => {
    setSelectedIds((prev) => (prev.size === files.length ? new Set() : new Set(files.map((file) => file.id))))
  }

  return { selectedIds, setSelectedIds, activeFile, setActiveFile, handleToggleSelect, handleToggleSelectAll }
}

function useHubDialogs() {
  const [qrFile, setQrFile] = useState<HubAttachmentWithUsage | null>(null)
  const [renameFile, setRenameFile] = useState<HubAttachmentWithUsage | null>(null)
  const [movingFileIds, setMovingFileIds] = useState<string[] | null>(null)
  return { qrFile, setQrFile, renameFile, setRenameFile, movingFileIds, setMovingFileIds }
}

function useHubHandlers(
  scope: AttachmentHubScope,
  files: { files: HubAttachmentWithUsage[]; setFiles: Setter<HubAttachmentWithUsage[]> },
  selection: { selectedIds: Set<string>; setSelectedIds: Setter<Set<string>>; activeFile: HubAttachmentWithUsage | null; setActiveFile: Setter<HubAttachmentWithUsage | null> },
  dialogs: { renameFile: HubAttachmentWithUsage | null },
  toast: ToastFn,
) {
  const patchLocal = (id: string, patch: Partial<HubAttachmentWithUsage>) => {
    files.setFiles((prev) => prev.map((file) => (file.id === id ? { ...file, ...patch } : file)))
    if (selection.activeFile?.id === id) {
      selection.setActiveFile((prev) => (prev ? { ...prev, ...patch } : null))
    }
  }

  const dropSelection = (ids: Set<string>) => {
    selection.setSelectedIds((prev) => {
      const next = new Set(prev)
      for (const id of ids) next.delete(id)
      return next
    })
    if (selection.activeFile && ids.has(selection.activeFile.id)) selection.setActiveFile(null)
  }

  const [previewFile, setPreviewFile] = useState<HubAttachmentWithUsage | null>(null)

  /** Every type previews through the one lazy viewer, so a PDF and an image open the same way. */
  const handlePreview = (file: HubAttachmentWithUsage) => setPreviewFile(file)

  const handleToggleFlag = async (file: HubAttachmentWithUsage, flag: 'isStarred' | 'isPinned') => {
    const next = !file[flag]
    try {
      await attachmentHubApi.patch(scope, file.id, { [flag]: next })
      patchLocal(file.id, flag === 'isStarred' ? { isStarred: next } : { isPinned: next })
    }
    catch {
      failed(toast, 'common.action_failed')
    }
  }

  const handleRename = async (newName: string) => {
    const target = dialogs.renameFile
    if (!target) return
    try {
      const updated = await attachmentHubApi.patch(scope, target.id, { filename: newName })
      patchLocal(target.id, { filename: updated.filename })
      toast({ title: t('attachments.saved'), tone: 'success' })
    }
    catch {
      failed(toast, 'common.save_failed')
    }
  }

  const handleUpdateTags = async (file: HubAttachmentWithUsage, tags: string[]) => {
    try {
      await attachmentHubApi.patch(scope, file.id, { tags })
      patchLocal(file.id, { tags })
    }
    catch {
      failed(toast, 'common.save_failed')
    }
  }

  const handleDeleteFile = async (file: HubAttachmentWithUsage) => {
    const ok = await confirm({
      title: t('attachments.delete_confirm_value0', { value0: file.filename }),
      description: file.references > 0 ? t('attachments.referenced_value0', { value0: file.references }) : undefined,
      confirmLabel: t('common.delete'),
      tone: 'danger',
    })
    if (!ok) return
    try {
      await attachmentHubApi.remove(scope, file.id)
      files.setFiles((prev) => prev.filter((item) => item.id !== file.id))
      dropSelection(new Set([file.id]))
      toast({ title: t('attachments.deleted'), tone: 'success' })
    }
    catch {
      failed(toast, 'attachments.delete_failed')
    }
  }

  const handleBatchDelete = async () => {
    const ids = Array.from(selection.selectedIds)
    if (ids.length === 0) return
    const ok = await confirm({
      title: t('attachments.batch_delete_confirm', { value0: ids.length }),
      confirmLabel: t('common.delete'),
      tone: 'danger',
    })
    if (!ok) return
    try {
      await attachmentHubApi.batch(scope, { action: 'delete', ids })
      files.setFiles((prev) => prev.filter((file) => !selection.selectedIds.has(file.id)))
      dropSelection(selection.selectedIds)
      toast({ title: t('attachments.deleted'), tone: 'success' })
    }
    catch {
      failed(toast, 'attachments.delete_failed')
    }
  }

  const handleBatchStar = async () => {
    const ids = Array.from(selection.selectedIds)
    if (ids.length === 0) return
    try {
      await attachmentHubApi.batch(scope, { action: 'star', ids, isStarred: true })
      files.setFiles((prev) => prev.map((file) => (selection.selectedIds.has(file.id) ? { ...file, isStarred: true } : file)))
      toast({ title: t('attachments.saved'), tone: 'success' })
    }
    catch {
      failed(toast, 'common.action_failed')
    }
  }

  const handleBatchDownload = () => {
    for (const file of files.files) {
      if (selection.selectedIds.has(file.id)) downloadFile(file)
    }
  }

  const handleDropFilesToFolder = async (fileIds: string[], targetFolderId: string | null) => {
    if (fileIds.length === 0) return
    try {
      await attachmentHubApi.batch(scope, { action: 'move', ids: fileIds, folderId: targetFolderId })
      files.setFiles((prev) => prev.map((file) => (fileIds.includes(file.id) ? { ...file, folderId: targetFolderId } : file)))
      toast({ title: t('attachments.moved'), tone: 'success' })
    }
    catch {
      failed(toast, 'common.action_failed')
    }
  }

  return {
    handlePreview,
    previewFile,
    setPreviewFile,
    handleDownloadFile: downloadFile,
    handleToggleStar: (file: HubAttachmentWithUsage) => handleToggleFlag(file, 'isStarred'),
    handleTogglePin: (file: HubAttachmentWithUsage) => handleToggleFlag(file, 'isPinned'),
    handleRename,
    handleUpdateTags,
    handleDeleteFile,
    handleBatchDelete,
    handleBatchStar,
    handleBatchDownload,
    handleDropFilesToFolder,
  }
}

/** All the hub modal's state and commands, so its JSX stays a thin shell. */
export function useAttachmentHubModal(open: boolean) {
  const scope = useHubScope()
  const toast = useUi((state) => state.toast)
  const organizerFolders = useHubOrganizer(scope, (state) => state.folders)
  const filters = useHubFilters()
  const view = useHubView()
  const files = useHubFiles(open, scope, filters, toast)
  const selection = useHubSelection(open, files.files)
  const dialogs = useHubDialogs()
  const handlers = useHubHandlers(scope, files, selection, dialogs, toast)
  const [isDragOverMain, setIsDragOverMain] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  return {
    scope,
    toast,
    ...filters,
    ...view,
    ...files,
    ...selection,
    ...dialogs,
    ...handlers,
    isDragOverMain,
    setIsDragOverMain,
    fileInputRef,
    organizerFolders,
  }
}
