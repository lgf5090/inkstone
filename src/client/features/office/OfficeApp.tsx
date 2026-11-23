import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react'
import { ArrowLeft, PanelLeftClose, PanelLeftOpen, Plus, Sparkles } from 'lucide-react'
import type { MessageKey } from '@shared/locales/en-US'
import {
  isOfficeFolderName,
  isOfficeTagName,
  normalizeOfficeTitle,
  OFFICE_FILE_TYPES,
  OFFICE_LIMITS,
  officeSnapshotLimit,
  type OfficeFileType,
} from '@shared/office/constants'
import { asOfficeSnapshot, detectOfficeSnapshotType } from '@shared/office/snapshot'
import type { OfficeFileSummary, OfficeFolder, OfficeTag } from '@shared/office/model'
import { formatBytes } from '@shared/byte-format'
import { navigateToAddress, replaceAddress, usePathname, useSearch } from '../../lib/app-history'
import { numericCollator } from '../../lib/collator'
import { t, useLocale } from '../../lib/i18n'
import { useSession } from '../../store/session'
import { useUi } from '../../store/ui'
import { Button, IconButton } from '../../components/primitives'
import { confirm, Menu, Modal, prompt, Tooltip } from '../../components/overlay'
import { FolderPicker } from '../folders/FolderPicker'
import { childTagPath, renameTagSegment } from '../../lib/tag-tree'
import { officeApi, officeErrorText, type OfficeFolderPatch, type OfficeTagPatch } from './api'
import {
  emptyOfficeListState,
  officeFileAddress,
  officeListAddress,
  parseOfficeAddress,
  type OfficeListState,
  type OfficeSmartView,
} from './office-address'
import {
  DEFAULT_OFFICE_PREFS,
  OFFICE_OPEN_TABS_MAX,
  readOfficeOpenTabs,
  readOfficePrefs,
  writeOfficeOpenTabs,
  writeOfficePrefs,
  type OfficeFileTypeFilter,
  type OfficeOpenTab,
  type OfficePrefs,
  type OfficeSortDirection,
  type OfficeSortKey,
  type OfficeViewMode,
} from './office-prefs'
import { officeFolderPath, OfficeSidebar } from './OfficeSidebar'
import { OfficeFileList, type OfficeBreadcrumb } from './OfficeFileList'
import {
  officeSaveStateLabel,
  OfficeEditorTabs,
  type OfficeSaveState,
  type OfficeTabState,
} from './OfficeEditorTabs'
import { OfficeEditorHost } from './OfficeEditorHost'
import { OfficeVersions } from './OfficeVersions'
import { OfficeAiBridge } from './ai/OfficeAiBridge'
import { officePageContext } from './ai/office-surface'
import { AssistantDock } from '../chat/AssistantDock'
import { officeSmartViewLabel, officeTypeIcon, officeTypeLabel } from './office-menus'
import type { OfficeEditorHandle } from './editor/contracts'
import type { OfficeEditPlan } from '@shared/office/ai'
import { getOfficeEditorHandle } from './editor/runtime'
import './office.css'

const DEFAULT_TITLES: Record<OfficeFileType, MessageKey> = {
  sheets: 'office.default_title.sheets',
  docs: 'office.default_title.docs',
  slides: 'office.default_title.slides',
  bases: 'office.default_title.bases',
  boards: 'office.default_title.boards',
  pdfs: 'office.default_title.pdfs',
}

function compareFiles(a: OfficeFileSummary, b: OfficeFileSummary, key: OfficeSortKey, collator: Intl.Collator): number {
  const byTitle = collator.compare(a.title, b.title) || a.id.localeCompare(b.id)
  switch (key) {
    case 'name':
      return byTitle
    case 'created':
      return a.createdAt - b.createdAt || byTitle
    case 'type':
      return a.type.localeCompare(b.type) || byTitle
    case 'size':
      return a.size - b.size || byTitle
    case 'updated':
    default:
      return a.updatedAt - b.updatedAt || byTitle
  }
}

function sortOfficeFiles(
  files: readonly OfficeFileSummary[],
  key: OfficeSortKey,
  dir: OfficeSortDirection,
  collator: Intl.Collator,
): OfficeFileSummary[] {
  return [...files].sort((a, b) => {
    const order = compareFiles(a, b, key, collator)
    return dir === 'asc' ? order : -order
  })
}

function safeFileName(title: string): string {
  return title.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '-').trim() || 'office'
}

function viewIdentity(address: ReturnType<typeof parseOfficeAddress>): string {
  if (address.kind !== 'list') return ''
  return `${address.view}|${address.folderId ?? ''}|${address.tagId ?? ''}`
}

export function OfficeApp() {
  const pathname = usePathname()
  const search = useSearch()
  const locale = useLocale()
  const address = useMemo(() => parseOfficeAddress(pathname, search), [pathname, search])
  const user = useSession((state) => state.user)
  const userId = user?.id ?? 'anonymous'
  const toast = useUi((state) => state.toast)
  const assistantDockOpen = useUi((state) => state.assistantDockOpen)
  const toggleAssistantDock = useUi((state) => state.toggleAssistantDock)

  const [prefs, setPrefs] = useState<OfficePrefs>(() => readOfficePrefs(userId))
  const [folders, setFolders] = useState<OfficeFolder[]>([])
  const [tags, setTags] = useState<OfficeTag[]>([])
  const [rawFiles, setRawFiles] = useState<OfficeFileSummary[]>([])
  const [filesStatus, setFilesStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [filesError, setFilesError] = useState<string | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)
  const [typeFilter, setTypeFilter] = useState<OfficeFileTypeFilter>('all')
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [tabs, setTabs] = useState<OfficeOpenTab[]>([])
  const [tabsReady, setTabsReady] = useState(false)
  const [tabStates, setTabStates] = useState<Record<string, OfficeTabState>>({})
  const [clipboard, setClipboard] = useState<{ mode: 'copy' | 'cut'; ids: string[] } | null>(null)
  const [moveIds, setMoveIds] = useState<readonly string[] | null>(null)
  const [versionsFile, setVersionsFile] = useState<OfficeFileSummary | null>(null)
  const [detailsFile, setDetailsFile] = useState<OfficeFileSummary | null>(null)
  const [hostReloadKey, setHostReloadKey] = useState(0)
  /** The workbench header's own surfaces: a new-file menu and a way to fold the rails away. */
  const [newTabAnchor, setNewTabAnchor] = useState<{ x: number; y: number } | null>(null)
  const [sidebarOpen, setSidebarOpen] = useState(true)

  const lastListRef = useRef<OfficeListState>(emptyOfficeListState())
  const loadedListKeyRef = useRef<string | null>(null)
  const filesLengthRef = useRef(0)
  const handleRef = useRef<OfficeEditorHandle | null>(null)
  const handleFileRef = useRef<string | null>(null)
  const importInputRef = useRef<HTMLInputElement>(null)

  const refresh = useCallback(() => setRefreshKey((value) => value + 1), [])
  const navigateList = useCallback((state: OfficeListState) => {
    navigateToAddress(officeListAddress(state))
  }, [])

  useEffect(() => {
    setPrefs(readOfficePrefs(userId))
  }, [userId])

  useEffect(() => {
    if (address.kind === 'list') {
      lastListRef.current = {
        view: address.view,
        folderId: address.folderId,
        tagId: address.tagId,
        query: address.query,
      }
    }
  }, [address])

  useEffect(() => {
    const controller = new AbortController()
    void Promise.all([officeApi.folders(controller.signal), officeApi.tags(controller.signal)])
      .then(([folderResult, tagResult]) => {
        setFolders(folderResult.folders)
        setTags(tagResult.tags)
      }, (caught: unknown) => {
        if (controller.signal.aborted) return
        toast({ title: t('office.error.load'), description: officeErrorText(caught), tone: 'danger' })
      })
    return () => controller.abort()
  }, [refreshKey, toast])

  const listKey = address.kind === 'list'
    ? `${address.view}|${address.folderId ?? ''}|${address.tagId ?? ''}|${address.query}|${typeFilter}`
    : null

  useEffect(() => {
    if (address.kind !== 'list') return
    const controller = new AbortController()
    if (loadedListKeyRef.current !== listKey) {
      setFilesStatus('loading')
      setFilesError(null)
    }
    officeApi.listFiles({
      ...(typeFilter === 'all' ? {} : { type: typeFilter }),
      ...(address.query ? { query: address.query } : {}),
      ...(address.view === 'trash' ? { trash: true } : {}),
      ...(address.view === 'recent' ? { recent: true } : {}),
      ...(address.view === 'starred' ? { starred: true } : {}),
      ...(address.view === 'pinned' ? { pinned: true } : {}),
      ...(address.view === 'all' && address.folderId ? { folderId: address.folderId } : {}),
      ...(address.view === 'all' && address.tagId ? { tagId: address.tagId } : {}),
      limit: OFFICE_LIMITS.listLimit,
    }, controller.signal).then((result) => {
      if (controller.signal.aborted) return
      setRawFiles(result.files)
      setFilesStatus('ready')
      setFilesError(null)
      loadedListKeyRef.current = listKey
    }, (caught: unknown) => {
      if (controller.signal.aborted) return
      if (filesLengthRef.current > 0) {
        setFilesStatus('ready')
        toast({ title: t('office.error.load'), description: officeErrorText(caught), tone: 'danger' })
        return
      }
      setFilesError(officeErrorText(caught))
      setFilesStatus('error')
    })
    return () => controller.abort()
  }, [address, typeFilter, listKey, refreshKey, toast])

  const files = useMemo(() => {
    const visible = address.kind === 'list' && address.view === 'pinned'
      ? rawFiles.filter((file) => file.isPinned)
      : rawFiles
    return sortOfficeFiles(visible, prefs.sortKey, prefs.sortDir, numericCollator(locale))
  }, [rawFiles, address, prefs.sortKey, prefs.sortDir, locale])
  filesLengthRef.current = rawFiles.length

  const identity = viewIdentity(address)
  useEffect(() => {
    setRawFiles([])
    setSelected(new Set())
    setTypeFilter('all')
  }, [identity])

  useEffect(() => {
    setSelected(new Set())
  }, [typeFilter])

  useEffect(() => {
    setSelected((current) => {
      const ids = new Set(files.map((file) => file.id))
      const next = new Set([...current].filter((id) => ids.has(id)))
      return next.size === current.size ? current : next
    })
  }, [files])

  useEffect(() => {
    setTabs((current) => {
      let changed = false
      const next = current.map((tab) => {
        const file = rawFiles.find((entry) => entry.id === tab.id)
        if (!file || (file.title === tab.title && file.type === tab.type)) return tab
        changed = true
        return { ...tab, title: file.title, type: file.type }
      })
      return changed ? next : current
    })
  }, [rawFiles])

  useEffect(() => {
    if (address.kind !== 'list') return
    if (address.tagId && tags.length > 0 && !tags.some((tag) => tag.id === address.tagId)) {
      navigateList({ view: 'all', folderId: null, tagId: null, query: address.query })
    }
    if (address.folderId && folders.length > 0 && !folders.some((folder) => folder.id === address.folderId)) {
      navigateList({ view: 'all', folderId: null, tagId: null, query: address.query })
    }
  }, [address, tags, folders, navigateList])

  useEffect(() => {
    let alive = true
    const stored = readOfficeOpenTabs()
    if (stored.length === 0) {
      setTabsReady(true)
      return
    }
    void Promise.allSettled(stored.map(async (tab) => {
      const result = await officeApi.getFile(tab.id)
      return { id: result.file.id, type: result.file.type, title: result.file.title }
    })).then((results) => {
      if (!alive) return
      const aliveTabs = results
        .filter((result): result is PromiseFulfilledResult<OfficeOpenTab> => result.status === 'fulfilled')
        .map((result) => result.value)
      setTabs(aliveTabs.slice(0, OFFICE_OPEN_TABS_MAX))
      setTabsReady(true)
    })
    return () => {
      alive = false
    }
  }, [])

  useEffect(() => {
    if (tabsReady) writeOfficeOpenTabs(tabs)
  }, [tabs, tabsReady])

  const activeFileId = address.kind === 'editor' ? address.fileId : null
  const activeTab = useMemo(
    () => (activeFileId ? tabs.find((tab) => tab.id === activeFileId) ?? null : null),
    [activeFileId, tabs],
  )

  const markOpened = useCallback((fileId: string) => {
    // Recency is a nicety: a failed write leaves the list's order as it was, not the screen broken.
    void officeApi.openFile(fileId).catch((error: unknown) => {
      console.warn('[inkstone] Office file open could not be recorded', error)
    })
  }, [])

  useEffect(() => {
    if (address.kind !== 'editor' || !tabsReady) return
    if (tabs.some((tab) => tab.id === address.fileId)) return
    let alive = true
    officeApi.getFile(address.fileId).then(({ file }) => {
      if (!alive) return
      setTabs((current) => (current.some((tab) => tab.id === file.id)
        ? current
        : [...current, { id: file.id, type: file.type, title: file.title }].slice(-OFFICE_OPEN_TABS_MAX)))
      markOpened(file.id)
    }, (caught: unknown) => {
      if (!alive) return
      toast({ title: t('office.editor.unavailable'), description: officeErrorText(caught), tone: 'danger' })
      navigateToAddress(officeListAddress(lastListRef.current))
    })
    return () => {
      alive = false
    }
  }, [address, tabsReady, tabs, markOpened, toast])

  useEffect(() => {
    if (address.kind !== 'editor' || !activeTab) return
    if (activeTab.type !== address.fileType) replaceAddress(officeFileAddress(activeTab.type, activeTab.id))
  }, [address, activeTab])

  const savePrefs = useCallback((patch: Partial<OfficePrefs>) => {
    setPrefs((current) => {
      const next = { ...DEFAULT_OFFICE_PREFS, ...current, ...patch }
      writeOfficePrefs(userId, next)
      return next
    })
  }, [userId])

  const currentFolderId = address.kind === 'list' && address.view === 'all' ? address.folderId : null

  const openFile = useCallback((file: OfficeFileSummary) => {
    setTabs((current) => (current.some((tab) => tab.id === file.id)
      ? current.map((tab) => (tab.id === file.id ? { ...tab, type: file.type, title: file.title } : tab))
      : [...current, { id: file.id, type: file.type, title: file.title }].slice(-OFFICE_OPEN_TABS_MAX)))
    markOpened(file.id)
    navigateToAddress(officeFileAddress(file.type, file.id))
  }, [markOpened])

  const createFile = useCallback(async (type: OfficeFileType, folderId?: string | null) => {
    const target = folderId === undefined ? currentFolderId : folderId
    try {
      const { file } = await officeApi.createFile({ type, title: t(DEFAULT_TITLES[type]), folderId: target })
      toast({ title: t('office.toast.created'), tone: 'success' })
      refresh()
      openFile(file)
    } catch (caught) {
      toast({ title: t('office.toast.failed'), description: officeErrorText(caught), tone: 'danger' })
    }
  }, [currentFolderId, openFile, refresh, toast])

  const createFolder = useCallback(async (parentId: string | null) => {
    const name = await prompt({ title: t('office.folder.new'), confirmLabel: t('office.folder.new') })
    if (!name) return
    if (!isOfficeFolderName(name)) {
      toast({ title: t('office.name.invalid'), tone: 'danger' })
      return
    }
    try {
      await officeApi.createFolder({ name, parentId })
      toast({ title: t('office.toast.folder_created'), tone: 'success' })
      refresh()
    } catch (caught) {
      toast({ title: t('office.toast.failed'), description: officeErrorText(caught), tone: 'danger' })
    }
  }, [refresh, toast])

  const renameFolder = useCallback(async (folder: OfficeFolder) => {
    const name = await prompt({
      title: t('office.folder.rename'),
      defaultValue: folder.name,
      confirmLabel: t('office.action.rename'),
    })
    if (!name || name === folder.name) return
    if (!isOfficeFolderName(name)) {
      toast({ title: t('office.name.invalid'), tone: 'danger' })
      return
    }
    try {
      await officeApi.patchFolder(folder.id, { name })
      toast({ title: t('office.toast.renamed'), tone: 'success' })
      refresh()
    } catch (caught) {
      toast({ title: t('office.toast.failed'), description: officeErrorText(caught), tone: 'danger' })
    }
  }, [refresh, toast])

  const patchFolder = useCallback(async (id: string, patch: OfficeFolderPatch) => {
    try {
      await officeApi.patchFolder(id, patch)
      refresh()
    } catch (caught) {
      toast({ title: t('office.toast.failed'), description: officeErrorText(caught), tone: 'danger' })
    }
  }, [refresh, toast])

  const moveFolder = useCallback(async (id: string, parentId: string | null) => {
    try {
      await officeApi.patchFolder(id, { parentId })
      toast({ title: t('office.toast.moved'), tone: 'success' })
      refresh()
    } catch (caught) {
      toast({ title: t('office.toast.failed'), description: officeErrorText(caught), tone: 'danger' })
    }
  }, [refresh, toast])

  const sortFolderSiblings = useCallback(async (parentId: string | null, key: 'name' | 'updated') => {
    const collator = numericCollator(locale)
    const siblings = folders.filter((folder) => (folder.parentId ?? null) === parentId)
    const sorted = [...siblings].sort(key === 'name'
      ? (a, b) => collator.compare(a.name, b.name)
      : (a, b) => a.updatedAt - b.updatedAt)
    try {
      for (const folder of sorted) await officeApi.patchFolder(folder.id, { beforeId: null })
      toast({ title: t('office.toast.updated'), tone: 'success' })
      refresh()
    } catch (caught) {
      toast({ title: t('office.toast.failed'), description: officeErrorText(caught), tone: 'danger' })
    }
  }, [folders, locale, refresh, toast])

  const deleteFolder = useCallback(async (folder: OfficeFolder, strategy: 'move-up' | 'delete') => {
    const ok = await confirm({
      title: t('office.folder.delete.title', { value0: folder.name }),
      description: strategy === 'move-up'
        ? t('office.folder.delete.move_up_description')
        : t('office.folder.delete.delete_subtree_description'),
      confirmLabel: strategy === 'move-up' ? t('office.folder.delete.move_up') : t('office.folder.delete.delete_subtree'),
      tone: 'danger',
    })
    if (!ok) return
    try {
      await officeApi.removeFolder(folder.id, strategy)
      if (strategy === 'delete') {
        toast({
          title: t('office.toast.folder_deleted'),
          tone: 'success',
          action: {
            label: t('common.undo'),
            run: () => {
              void officeApi.restoreFolder(folder.id).then(() => {
                toast({ title: t('office.toast.restored'), tone: 'success' })
                refresh()
              }, (caught: unknown) => {
                toast({ title: t('office.toast.failed'), description: officeErrorText(caught), tone: 'danger' })
              })
            },
          },
        })
      } else {
        toast({ title: t('office.toast.folder_deleted'), tone: 'success' })
      }
      if (address.kind === 'list' && address.folderId &&
        officeFolderPath(folders, address.folderId).some((entry) => entry.id === folder.id)) {
        navigateList({ view: 'all', folderId: null, tagId: null, query: '' })
      } else {
        refresh()
      }
    } catch (caught) {
      toast({ title: t('office.toast.failed'), description: officeErrorText(caught), tone: 'danger' })
    }
  }, [address, folders, navigateList, refresh, toast])

  const moveFiles = useCallback(async (ids: readonly string[], folderId: string | null) => {
    if (ids.length === 0) return
    try {
      await officeApi.batch({ ids: [...ids], action: 'move', folderId })
      toast({ title: t('office.toast.moved'), tone: 'success' })
      setSelected(new Set())
      refresh()
    } catch (caught) {
      toast({ title: t('office.toast.failed'), description: officeErrorText(caught), tone: 'danger' })
    }
  }, [refresh, toast])

  const createTag = useCallback(async (parentPath: string | null) => {
    const leaf = await prompt({
      title: parentPath ? t('office.tag.new_child') : t('office.tag.new'),
      confirmLabel: t('office.tag.new'),
    })
    if (!leaf) return
    const name = parentPath ? childTagPath(parentPath, leaf) : leaf.trim().replace(/^#+/, '')
    if (!isOfficeTagName(name)) {
      toast({ title: t('office.name.invalid'), tone: 'danger' })
      return
    }
    try {
      await officeApi.createTag({ name })
      toast({ title: t('office.toast.tag_created'), tone: 'success' })
      refresh()
    } catch (caught) {
      toast({ title: t('office.toast.failed'), description: officeErrorText(caught), tone: 'danger' })
    }
  }, [refresh, toast])

  const renameTag = useCallback(async (tag: OfficeTag) => {
    const leaf = tag.name.split('/').pop() ?? tag.name
    const next = await prompt({
      title: t('office.tag.rename'),
      defaultValue: leaf,
      confirmLabel: t('office.action.rename'),
    })
    if (!next) return
    const name = renameTagSegment(tag.name, next)
    if (name === tag.name) return
    if (!isOfficeTagName(name)) {
      toast({ title: t('office.name.invalid'), tone: 'danger' })
      return
    }
    try {
      await officeApi.patchTag(tag.id, { name })
      toast({ title: t('office.toast.renamed'), tone: 'success' })
      refresh()
    } catch (caught) {
      toast({ title: t('office.toast.failed'), description: officeErrorText(caught), tone: 'danger' })
    }
  }, [refresh, toast])

  const patchTag = useCallback(async (id: string, patch: OfficeTagPatch) => {
    try {
      await officeApi.patchTag(id, patch)
      refresh()
    } catch (caught) {
      toast({ title: t('office.toast.failed'), description: officeErrorText(caught), tone: 'danger' })
    }
  }, [refresh, toast])

  const moveTag = useCallback(async (tag: OfficeTag, parentPath: string) => {
    const leaf = tag.name.split('/').pop() ?? tag.name
    const name = childTagPath(parentPath, leaf)
    if (name === tag.name) return
    if (!isOfficeTagName(name)) {
      toast({ title: t('office.name.invalid'), tone: 'danger' })
      return
    }
    try {
      await officeApi.patchTag(tag.id, { name })
      toast({ title: t('office.toast.moved'), tone: 'success' })
      refresh()
    } catch (caught) {
      toast({ title: t('office.toast.failed'), description: officeErrorText(caught), tone: 'danger' })
    }
  }, [refresh, toast])

  const deleteTag = useCallback(async (tag: OfficeTag) => {
    const ok = await confirm({
      title: t('office.tag.delete.title', { value0: tag.name }),
      description: t('office.tag.delete.description'),
      confirmLabel: t('office.tag.delete'),
      tone: 'danger',
    })
    if (!ok) return
    try {
      await officeApi.removeTag(tag.id)
      toast({ title: t('office.toast.tag_deleted'), tone: 'success' })
      if (address.kind === 'list' && address.tagId === tag.id) {
        navigateList({ view: 'all', folderId: null, tagId: null, query: '' })
      } else {
        refresh()
      }
    } catch (caught) {
      toast({ title: t('office.toast.failed'), description: officeErrorText(caught), tone: 'danger' })
    }
  }, [address, navigateList, refresh, toast])

  const renameFile = useCallback(async (file: OfficeFileSummary) => {
    const name = await prompt({
      title: t('office.action.rename'),
      defaultValue: file.title,
      confirmLabel: t('office.action.rename'),
    })
    if (!name || name === file.title) return
    const title = normalizeOfficeTitle(name)
    if (!title) {
      toast({ title: t('office.name.invalid'), tone: 'danger' })
      return
    }
    try {
      await officeApi.patchFile(file.id, { title })
      setTabs((current) => current.map((tab) => (tab.id === file.id ? { ...tab, title } : tab)))
      toast({ title: t('office.toast.renamed'), tone: 'success' })
      refresh()
    } catch (caught) {
      toast({ title: t('office.toast.failed'), description: officeErrorText(caught), tone: 'danger' })
    }
  }, [refresh, toast])

  const duplicateFile = useCallback(async (source: { id: string }, open = false) => {
    try {
      const result = await officeApi.duplicateFile(source.id)
      toast({ title: t('office.toast.copied'), tone: 'success' })
      refresh()
      if (open) openFile(result.file)
    } catch (caught) {
      toast({ title: t('office.toast.failed'), description: officeErrorText(caught), tone: 'danger' })
    }
  }, [openFile, refresh, toast])

  const downloadFile = useCallback(async (file: OfficeFileSummary) => {
    try {
      const result = await officeApi.snapshot(file.id)
      if (!result.snapshot) {
        toast({ title: t('office.download.empty'), tone: 'default' })
        return
      }
      const blob = new Blob([JSON.stringify(result.snapshot, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = `${safeFileName(file.title)}.json`
      document.body.append(anchor)
      try {
        anchor.click()
      } finally {
        anchor.remove()
        window.setTimeout(() => URL.revokeObjectURL(url), 60_000)
      }
    } catch (caught) {
      toast({ title: t('office.download.failed'), description: officeErrorText(caught), tone: 'danger' })
    }
  }, [toast])

  const toggleStar = useCallback(async (targets: readonly OfficeFileSummary[]) => {
    if (targets.length === 0) return
    const starred = !targets.every((file) => file.isStarred)
    try {
      if (starred) {
        if (targets.length === 1) await officeApi.patchFile(targets[0]!.id, { isStarred: true })
        else await officeApi.batch({ ids: targets.map((file) => file.id), action: 'star' })
      } else {
        for (const file of targets) await officeApi.patchFile(file.id, { isStarred: false })
      }
      toast({ title: t('office.toast.updated'), tone: 'success' })
      refresh()
    } catch (caught) {
      toast({ title: t('office.toast.failed'), description: officeErrorText(caught), tone: 'danger' })
    }
  }, [refresh, toast])

  const togglePin = useCallback(async (file: OfficeFileSummary) => {
    try {
      await officeApi.patchFile(file.id, { isPinned: !file.isPinned })
      toast({ title: t('office.toast.updated'), tone: 'success' })
      refresh()
    } catch (caught) {
      toast({ title: t('office.toast.failed'), description: officeErrorText(caught), tone: 'danger' })
    }
  }, [refresh, toast])

  const addTag = useCallback(async (targets: readonly OfficeFileSummary[], tagIds: string[]) => {
    if (targets.length === 0 || tagIds.length === 0) return
    try {
      await officeApi.batch({ ids: targets.map((file) => file.id), action: 'tag', tagIds })
      toast({ title: t('office.toast.updated'), tone: 'success' })
      refresh()
    } catch (caught) {
      toast({ title: t('office.toast.failed'), description: officeErrorText(caught), tone: 'danger' })
    }
  }, [refresh, toast])

  const copyFiles = useCallback((targets: readonly OfficeFileSummary[]) => {
    if (targets.length === 0) return
    setClipboard({ mode: 'copy', ids: targets.map((file) => file.id) })
  }, [])

  const cutFiles = useCallback((targets: readonly OfficeFileSummary[]) => {
    if (targets.length === 0) return
    setClipboard({ mode: 'cut', ids: targets.map((file) => file.id) })
  }, [])

  const pasteInto = useCallback(async (folderId: string | null) => {
    if (!clipboard) return
    try {
      await officeApi.batch({
        ids: clipboard.ids,
        action: clipboard.mode === 'copy' ? 'copy' : 'move',
        folderId,
      })
      toast({ title: t(clipboard.mode === 'copy' ? 'office.toast.copied' : 'office.toast.moved'), tone: 'success' })
      if (clipboard.mode === 'cut') setClipboard(null)
      refresh()
    } catch (caught) {
      toast({ title: t('office.toast.failed'), description: officeErrorText(caught), tone: 'danger' })
    }
  }, [clipboard, refresh, toast])

  const forgetTabs = useCallback((ids: ReadonlySet<string>) => {
    if (ids.size === 0) return
    setTabs((current) => {
      const next = current.filter((tab) => !ids.has(tab.id))
      return next.length === current.length ? current : next
    })
    setTabStates((current) => {
      const next: Record<string, OfficeTabState> = {}
      for (const [id, state] of Object.entries(current)) {
        if (!ids.has(id)) next[id] = state
      }
      return next
    })
    if (address.kind === 'editor' && ids.has(address.fileId)) {
      navigateToAddress(officeListAddress(lastListRef.current))
    }
  }, [address])

  const purgeFiles = useCallback(async (targets: readonly OfficeFileSummary[]) => {
    if (targets.length === 0) return
    const ok = await confirm({
      title: t('office.confirm.purge.title'),
      description: t('office.confirm.purge.description'),
      confirmLabel: t('office.action.purge'),
      tone: 'danger',
    })
    if (!ok) return
    try {
      for (const file of targets) await officeApi.removeFile(file.id, true)
      forgetTabs(new Set(targets.map((file) => file.id)))
      toast({ title: t('office.toast.purged'), tone: 'success' })
      setSelected(new Set())
      refresh()
    } catch (caught) {
      toast({ title: t('office.toast.failed'), description: officeErrorText(caught), tone: 'danger' })
    }
  }, [forgetTabs, refresh, toast])

  const deleteFiles = useCallback(async (targets: readonly OfficeFileSummary[]) => {
    if (targets.length === 0) return
    if (address.kind === 'list' && address.view === 'trash') {
      await purgeFiles(targets)
      return
    }
    const ok = await confirm({
      title: targets.length === 1 ? t('office.confirm.delete.title') : t('office.confirm.delete.batch_title', { count: targets.length }),
      description: targets.length === 1
        ? t('office.confirm.delete.description')
        : t('office.confirm.delete.batch_description', { count: targets.length }),
      confirmLabel: t('office.action.delete'),
      tone: 'danger',
    })
    if (!ok) return
    try {
      if (targets.length === 1) await officeApi.removeFile(targets[0]!.id)
      else await officeApi.batch({ ids: targets.map((file) => file.id), action: 'delete' })
      forgetTabs(new Set(targets.map((file) => file.id)))
      toast({ title: t('office.toast.deleted'), tone: 'success' })
      setSelected(new Set())
      refresh()
    } catch (caught) {
      toast({ title: t('office.toast.failed'), description: officeErrorText(caught), tone: 'danger' })
    }
  }, [address, forgetTabs, purgeFiles, refresh, toast])

  const restoreFiles = useCallback(async (targets: readonly OfficeFileSummary[]) => {
    if (targets.length === 0) return
    try {
      for (const file of targets) await officeApi.restoreFile(file.id)
      toast({ title: t('office.toast.restored'), tone: 'success' })
      setSelected(new Set())
      refresh()
    } catch (caught) {
      toast({ title: t('office.toast.failed'), description: officeErrorText(caught), tone: 'danger' })
    }
  }, [refresh, toast])

  const flushActive = useCallback(async (): Promise<boolean> => {
    const handle = handleRef.current
    if (!handle) return true
    try {
      await handle.flush()
      return true
    } catch (caught) {
      toast({ title: t('office.save.failed'), description: officeErrorText(caught), tone: 'danger' })
      return false
    }
  }, [toast])

  const confirmDiscard = useCallback(() => confirm({
    title: t('office.confirm.close_dirty.title'),
    description: t('office.confirm.close_dirty.description'),
    confirmLabel: t('office.menu.tab.close'),
    tone: 'danger',
  }), [])

  const isTabDirty = useCallback((id: string): boolean => {
    const state = tabStates[id]
    return Boolean(state?.dirty || state?.save === 'dirty' || state?.save === 'failed')
  }, [tabStates])

  const activateTab = useCallback(async (id: string) => {
    if (address.kind === 'editor' && address.fileId === id) return
    const tab = tabs.find((entry) => entry.id === id)
    if (!tab) return
    if (!(await flushActive())) return
    navigateToAddress(officeFileAddress(tab.type, tab.id))
  }, [address, tabs, flushActive])

  const closeTab = useCallback(async (id: string) => {
    const index = tabs.findIndex((tab) => tab.id === id)
    if (index < 0) return
    const isActive = address.kind === 'editor' && address.fileId === id
    if (isActive) {
      const flushed = await flushActive()
      if (!flushed && !(await confirmDiscard())) return
    } else if (isTabDirty(id) && !(await confirmDiscard())) {
      return
    }
    const next = tabs.filter((tab) => tab.id !== id)
    setTabs(next)
    setTabStates((current) => {
      const copy = { ...current }
      delete copy[id]
      return copy
    })
    if (isActive) {
      const neighbor = next[Math.min(index, next.length - 1)]
      navigateToAddress(neighbor
        ? officeFileAddress(neighbor.type, neighbor.id)
        : officeListAddress(lastListRef.current))
    }
  }, [address, tabs, flushActive, confirmDiscard, isTabDirty])

  const closeOthers = useCallback(async (id: string) => {
    const keep = tabs.find((tab) => tab.id === id)
    if (!keep) return
    const closing = tabs.filter((tab) => tab.id !== id)
    if (closing.some((tab) => isTabDirty(tab.id)) && !(await confirmDiscard())) return
    setTabs([keep])
    setTabStates((current) => {
      const next: Record<string, OfficeTabState> = {}
      if (current[id]) next[id] = current[id]!
      return next
    })
  }, [tabs, confirmDiscard, isTabDirty])

  const closeRight = useCallback(async (id: string) => {
    const index = tabs.findIndex((tab) => tab.id === id)
    if (index < 0) return
    const closing = tabs.slice(index + 1)
    if (closing.length === 0) return
    if (closing.some((tab) => isTabDirty(tab.id)) && !(await confirmDiscard())) return
    const kept = tabs.slice(0, index + 1)
    setTabs(kept)
    setTabStates((current) => {
      const next: Record<string, OfficeTabState> = {}
      for (const tab of kept) if (current[tab.id]) next[tab.id] = current[tab.id]!
      return next
    })
  }, [tabs, confirmDiscard, isTabDirty])

  const showInList = useCallback((tab: OfficeOpenTab) => {
    navigateToAddress(officeListAddress({ view: 'all', folderId: null, tagId: null, query: tab.title }))
  }, [])

  const onEditorDirty = useCallback((fileId: string, dirty: boolean) => {
    setTabStates((current) => ({
      ...current,
      [fileId]: {
        dirty,
        save: dirty ? 'dirty' : current[fileId]?.save === 'failed' ? 'failed' : 'idle',
      },
    }))
  }, [])

  const onEditorSave = useCallback((fileId: string, save: OfficeSaveState) => {
    setTabStates((current) => ({
      ...current,
      [fileId]: {
        dirty: save === 'dirty' || save === 'failed' ? true : save === 'saving' ? Boolean(current[fileId]?.dirty) : false,
        save,
      },
    }))
  }, [])

  const onEditorHandle = useCallback((fileId: string, handle: OfficeEditorHandle | null) => {
    if (handle) {
      handleRef.current = handle
      handleFileRef.current = fileId
      return
    }
    if (handleFileRef.current === fileId) {
      handleRef.current = null
      handleFileRef.current = null
    }
  }, [])

  /*
   * A development-only door onto the open editor, so an end-to-end check can apply a plan and undo it
   * without asking a model to produce one. `import.meta.env.DEV` is statically false in a production
   * build, so the whole effect is dropped there and nothing ships with this surface.
   */
  useEffect(() => {
    if (!import.meta.env.DEV) return
    // The same registry the assistant's effects write through, so a check here exercises that path.
    const bridge = {
      applyPlan: async (fileId: string, plan: OfficeEditPlan): Promise<void> => {
        const handle = getOfficeEditorHandle(fileId)
        if (!handle) throw new Error('No office editor is open for ' + fileId)
        await handle.applyPlan(plan)
        await handle.flush()
      },
      undo: (fileId: string): void => getOfficeEditorHandle(fileId)?.undo(),
      handle: (fileId: string): OfficeEditorHandle | null => getOfficeEditorHandle(fileId),
    }
    ;(window as unknown as { __officeTest?: typeof bridge }).__officeTest = bridge
    return () => {
      delete (window as unknown as { __officeTest?: typeof bridge }).__officeTest
    }
  }, [])

  const onUnavailable = useCallback((fileId: string) => {
    forgetTabs(new Set([fileId]))
    toast({ title: t('office.editor.unavailable'), tone: 'danger' })
  }, [forgetTabs, toast])

  const triggerImport = useCallback(() => importInputRef.current?.click(), [])

  const importJson = useCallback(async (event: ChangeEvent<HTMLInputElement>) => {
    const picked = event.target.files?.[0]
    event.target.value = ''
    if (!picked) return
    if (picked.size > OFFICE_LIMITS.pdfSnapshotBytes) {
      toast({ title: t('office.import.too_large'), tone: 'danger' })
      return
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(await picked.text()) as unknown
    } catch {
      toast({ title: t('office.import.invalid'), tone: 'danger' })
      return
    }
    const snapshot = asOfficeSnapshot(parsed)
    if (!snapshot) {
      toast({ title: t('office.import.invalid'), tone: 'danger' })
      return
    }
    const type = detectOfficeSnapshotType(parsed)
    if (!type) {
      toast({ title: t('office.import.wrong_type'), tone: 'danger' })
      return
    }
    if (JSON.stringify(snapshot).length > officeSnapshotLimit(type)) {
      toast({ title: t('office.import.too_large'), tone: 'danger' })
      return
    }
    const title = normalizeOfficeTitle(picked.name.replace(/\.json$/i, '')) ?? t(DEFAULT_TITLES[type])
    let created: OfficeFileSummary | null = null
    try {
      const result = await officeApi.createFile({ type, title })
      created = result.file
      await officeApi.saveSnapshot(created.id, 0, snapshot)
      toast({ title: t('office.toast.imported'), tone: 'success' })
      refresh()
      openFile(created)
    } catch (caught) {
      toast({ title: t('office.toast.failed'), description: officeErrorText(caught), tone: 'danger' })
      if (created) {
        // An import that could not store its snapshot must not leave an empty file behind.
        void officeApi.removeFile(created.id, true).catch((error: unknown) => {
          console.warn('[inkstone] Office import cleanup failed', error)
        })
        refresh()
      }
    }
  }, [openFile, refresh, toast])

  const breadcrumbs = useMemo<OfficeBreadcrumb[]>(() => {
    if (address.kind !== 'list') return []
    const all: OfficeBreadcrumb = {
      label: t('office.view.all_files'),
      state: { view: 'all', folderId: null, tagId: null, query: '' },
    }
    if (address.view !== 'all') {
      return [all, {
        label: officeSmartViewLabel(address.view),
        state: { view: address.view, folderId: null, tagId: null, query: '' },
      }]
    }
    if (address.folderId) {
      const path = officeFolderPath(folders, address.folderId)
      return [all, ...path.map((folder): OfficeBreadcrumb => ({
        label: folder.name,
        state: { view: 'all', folderId: folder.id, tagId: null, query: '' },
      }))]
    }
    if (address.tagId) {
      const tag = tags.find((entry) => entry.id === address.tagId)
      return [all, {
        label: tag ? `#${tag.name}` : t('office.sidebar.tags'),
        state: { view: 'all', folderId: null, tagId: address.tagId, query: '' },
      }]
    }
    return [all]
  }, [address, folders, tags, locale])

  const detailsFolder = detailsFile?.folderId
    ? officeFolderPath(folders, detailsFile.folderId).map((folder) => folder.name).join(' / ')
    : t('office.details.root')
  const detailsDate = (timestamp: number): string => new Date(timestamp).toLocaleString(locale)

  const assistantPageContext = useMemo(() => officePageContext({
    fileId: activeFileId,
    fileType: activeTab?.type ?? null,
    title: activeTab?.title ?? null,
    folder: breadcrumbs.at(-1)?.label ?? null,
    view: address.kind === 'list' ? address.view : 'editor',
  }), [activeFileId, activeTab, address, breadcrumbs])

  const anyDirty = Object.values(tabStates).some((state) => state.dirty || state.save === 'dirty' || state.save === 'failed')
  useEffect(() => {
    if (!anyDirty) return
    // A dirty tab leaves with the last edit written: the page is hidden rather than blocked, because the
    // browser's own leave-page dialog is a forced API this app does not use.
    const flushOnHide = () => {
      void handleRef.current?.flush().catch((cause: unknown) => {
        // The tab is going away; the next open reads the server copy and reports what did not land.
        console.warn('[office] final save failed', cause)
      })
    }
    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') flushOnHide()
    }
    window.addEventListener('pagehide', flushOnHide)
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      window.removeEventListener('pagehide', flushOnHide)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [anyDirty])

  const activeState = activeTab ? tabStates[activeTab.id] : undefined
  const activeStatus = activeTab && activeState
    ? (activeState.save === 'saving' || activeState.save === 'failed'
        ? officeSaveStateLabel(activeState.save)
        : activeState.dirty
          ? t('office.save.unsaved')
          : officeSaveStateLabel(activeState.save))
    : null

  const fileActions = {
    onOpen: openFile,
    onRename: renameFile,
    onDuplicate: (file: OfficeFileSummary) => { void duplicateFile(file) },
    onDownload: (file: OfficeFileSummary) => { void downloadFile(file) },
    onToggleStar: (targets: readonly OfficeFileSummary[]) => { void toggleStar(targets) },
    onTogglePin: (file: OfficeFileSummary) => { void togglePin(file) },
    onCopy: copyFiles,
    onCut: cutFiles,
    onPaste: (folderId: string | null) => { void pasteInto(folderId) },
    onMove: (targets: readonly OfficeFileSummary[]) => setMoveIds(targets.map((file) => file.id)),
    onAddTag: (targets: readonly OfficeFileSummary[], tagIds: string[]) => { void addTag(targets, tagIds) },
    onVersions: (file: OfficeFileSummary) => setVersionsFile(file),
    onDetails: (file: OfficeFileSummary) => setDetailsFile(file),
    onDelete: (targets: readonly OfficeFileSummary[]) => { void deleteFiles(targets) },
    onRestore: (targets: readonly OfficeFileSummary[]) => { void restoreFiles(targets) },
    onPurge: (targets: readonly OfficeFileSummary[]) => { void purgeFiles(targets) },
    onCreateFile: (type: OfficeFileType) => { void createFile(type, currentFolderId) },
    onCreateFolder: () => { void createFolder(currentFolderId) },
    onImport: triggerImport,
    onRefresh: refresh,
  }

  const sidebar = address.kind === 'list' && (
    <OfficeSidebar
      view={address.view}
      folderId={address.folderId}
      tagId={address.tagId}
      folders={folders}
      tags={tags}
      clipboardHasFiles={clipboard !== null}
      onSelectView={(view: OfficeSmartView) => navigateList({ view, folderId: null, tagId: null, query: '' })}
      onSelectFolder={(id) => navigateList({ view: 'all', folderId: id, tagId: null, query: '' })}
      onSelectTag={(id) => navigateList({ view: 'all', folderId: null, tagId: id, query: '' })}
      onCreateFile={(folderId, type) => { void createFile(type, folderId) }}
      onImportJson={triggerImport}
      onCreateFolder={(parentId) => { void createFolder(parentId) }}
      onRenameFolder={(folder) => { void renameFolder(folder) }}
      onPatchFolder={(id, patch) => { void patchFolder(id, patch) }}
      onMoveFolder={(id, parentId) => { void moveFolder(id, parentId) }}
      onSortFolderSiblings={(parentId, key) => { void sortFolderSiblings(parentId, key) }}
      onDeleteFolder={(folder, strategy) => { void deleteFolder(folder, strategy) }}
      onMoveFiles={(ids, folderId) => { void moveFiles(ids, folderId) }}
      onPaste={(folderId) => { void pasteInto(folderId) }}
      onCreateTag={(parentPath) => { void createTag(parentPath) }}
      onRenameTag={(tag) => { void renameTag(tag) }}
      onPatchTag={(id, patch) => { void patchTag(id, patch) }}
      onMoveTag={(tag, parentPath) => { void moveTag(tag, parentPath) }}
      onDeleteTag={(tag) => { void deleteTag(tag) }}
    />
  )

  return (
    <div
      data-office-app=""
      className="office-app flex h-full min-h-0 min-w-0 bg-[var(--bg-base)]"
      onContextMenu={(event) => event.preventDefault()}
    >
      {sidebarOpen && sidebar}
      {address.kind === 'list'
        ? (
            <OfficeFileList
              {...fileActions}
              files={files}
              status={filesStatus}
              error={filesError}
              query={address.query}
              typeFilter={typeFilter}
              viewMode={prefs.viewMode}
              sortKey={prefs.sortKey}
              sortDir={prefs.sortDir}
              showCheckboxes={prefs.showCheckboxes}
              activeView={address.view}
              currentFolderId={currentFolderId}
              breadcrumbs={breadcrumbs}
              tags={tags}
              selected={selected}
              clipboardHasFiles={clipboard !== null}
              onSearchChange={(query) => {
                if (address.kind !== 'list') return
                replaceAddress(officeListAddress({
                  view: address.view,
                  folderId: address.folderId,
                  tagId: address.tagId,
                  query,
                }))
              }}
              onTypeChange={setTypeFilter}
              onSortChange={(key: OfficeSortKey, dir: OfficeSortDirection) => savePrefs({ sortKey: key, sortDir: dir })}
              onViewModeChange={(mode: OfficeViewMode) => savePrefs({ viewMode: mode })}
              onToggleCheckboxes={() => savePrefs({ showCheckboxes: !prefs.showCheckboxes })}
              onSelectChange={setSelected}
              onNavigate={navigateList}
            />
          )
        : (
            <section className="flex min-h-0 min-w-0 flex-1 flex-col">
              <div className="flex h-11 shrink-0 items-center gap-1 border-b border-[var(--border-subtle)] bg-[var(--bg-sunken)] pr-2">
                <Tooltip label={t('office.editor.back')} side="bottom">
                  <IconButton
                    label={t('office.editor.back')}
                    onClick={() => navigateToAddress(officeListAddress(lastListRef.current))}
                  >
                    <ArrowLeft size={15} />
                  </IconButton>
                </Tooltip>
                <OfficeEditorTabs
                  tabs={tabs}
                  activeId={activeFileId}
                  states={tabStates}
                  onActivate={(id) => { void activateTab(id) }}
                  onClose={(id) => { void closeTab(id) }}
                  onCloseOthers={(id) => { void closeOthers(id) }}
                  onCloseRight={(id) => { void closeRight(id) }}
                  onDuplicate={(tab) => { void duplicateFile(tab, true) }}
                  onShowInList={showInList}
                />
                {activeStatus && (
                  <span className="shrink-0 text-[length:var(--text-10-5)] text-[var(--text-tertiary)]" aria-live="polite">
                    {activeStatus}
                  </span>
                )}
                <Tooltip label={t('office.tab.new')} side="bottom">
                  <IconButton
                    label={t('office.tab.new')}
                    active={newTabAnchor !== null}
                    onClick={(event) => {
                      if (newTabAnchor) { setNewTabAnchor(null); return }
                      const rect = event.currentTarget.getBoundingClientRect()
                      setNewTabAnchor({ x: rect.right - 200, y: rect.bottom + 4 })
                    }}
                  >
                    <Plus size={15} />
                  </IconButton>
                </Tooltip>
                <Menu
                  anchor={newTabAnchor ?? { x: 0, y: 0 }}
                  open={newTabAnchor !== null}
                  onClose={() => setNewTabAnchor(null)}
                  width={200}
                  items={OFFICE_FILE_TYPES.map((type) => ({
                    id: type,
                    label: officeTypeLabel(type),
                    icon: officeTypeIcon(type),
                    onSelect: () => {
                      setNewTabAnchor(null)
                      void createFile(type, currentFolderId)
                    },
                  }))}
                />
                <Tooltip label={sidebarOpen ? t('office.sidebar.hide') : t('office.sidebar.show')} side="bottom">
                  <IconButton
                    label={sidebarOpen ? t('office.sidebar.hide') : t('office.sidebar.show')}
                    onClick={() => setSidebarOpen((open) => !open)}
                  >
                    {sidebarOpen ? <PanelLeftClose size={15} /> : <PanelLeftOpen size={15} />}
                  </IconButton>
                </Tooltip>
                <Tooltip label={t('office.ai.open')} side="bottom">
                  <IconButton label={t('office.ai.open')} onClick={toggleAssistantDock}>
                    <Sparkles size={15} />
                  </IconButton>
                </Tooltip>
              </div>
              {activeTab
                ? (
                    <OfficeEditorHost
                      file={activeTab}
                      reloadKey={hostReloadKey}
                      onDirtyChange={onEditorDirty}
                      onSaveState={onEditorSave}
                      onHandle={onEditorHandle}
                      onUnavailable={onUnavailable}
                    />
                  )
                : <OfficeFileListPlaceholder />}
            </section>
          )}

      <OfficeAiBridge />
      {assistantDockOpen && <AssistantDock surface="office" pageContext={assistantPageContext} />}

      <FolderPicker
        open={moveIds !== null}
        title={t('office.action.move')}
        folders={folders}
        currentId={null}
        onSelect={(folderId) => {
          if (moveIds) void moveFiles(moveIds, folderId)
        }}
        onClose={() => setMoveIds(null)}
      />

      <OfficeVersions
        open={versionsFile !== null}
        file={versionsFile}
        onClose={() => setVersionsFile(null)}
        onRestored={() => {
          setHostReloadKey((value) => value + 1)
          refresh()
        }}
      />

      <OfficeDetails
        open={detailsFile !== null}
        file={detailsFile}
        folderLabel={detailsFolder}
        formatDate={detailsDate}
        onClose={() => setDetailsFile(null)}
      />

      <input
        ref={importInputRef}
        type="file"
        accept="application/json,.json"
        hidden
        onChange={(event) => { void importJson(event) }}
      />
    </div>
  )
}

function OfficeFileListPlaceholder() {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center">
      <span className="text-[length:var(--text-12)] text-[var(--text-quaternary)]">{t('office.editor.loading')}</span>
    </div>
  )
}

function OfficeDetails({
  open, file, folderLabel, formatDate, onClose,
}: {
  open: boolean
  file: OfficeFileSummary | null
  folderLabel: string
  formatDate: (timestamp: number) => string
  onClose: () => void
}) {
  return (
    <Modal open={open && file !== null} onClose={onClose} title={t('office.details.title')} width={460}
      footer={<Button variant="ghost" onClick={onClose}>{t('common.close')}</Button>}>
      {file && (
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-[length:var(--text-12)]">
          <dt className="text-[var(--text-tertiary)]">{t('office.name.title')}</dt>
          <dd className="min-w-0 break-words text-[var(--text-primary)]">{file.title}</dd>
          <dt className="text-[var(--text-tertiary)]">{t('office.details.type')}</dt>
          <dd className="text-[var(--text-primary)]">{officeTypeLabel(file.type)}</dd>
          <dt className="text-[var(--text-tertiary)]">{t('office.details.folder')}</dt>
          <dd className="min-w-0 break-words text-[var(--text-primary)]">{folderLabel}</dd>
          <dt className="text-[var(--text-tertiary)]">{t('office.details.size')}</dt>
          <dd className="tabular text-[var(--text-primary)]">{formatBytes(file.size)}</dd>
          <dt className="text-[var(--text-tertiary)]">{t('office.details.revision')}</dt>
          <dd className="tabular text-[var(--text-primary)]">{`v${file.rev}`}</dd>
          <dt className="text-[var(--text-tertiary)]">{t('office.details.created')}</dt>
          <dd className="text-[var(--text-primary)]">{formatDate(file.createdAt)}</dd>
          <dt className="text-[var(--text-tertiary)]">{t('office.details.updated')}</dt>
          <dd className="text-[var(--text-primary)]">{formatDate(file.updatedAt)}</dd>
          <dt className="text-[var(--text-tertiary)]">{t('office.details.id')}</dt>
          <dd className="min-w-0 break-all font-mono text-[length:var(--text-11)] text-[var(--text-secondary)]">{file.id}</dd>
        </dl>
      )}
    </Modal>
  )
}