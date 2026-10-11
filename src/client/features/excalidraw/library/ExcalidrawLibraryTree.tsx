import React, { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  Folder,
  FolderPlus,
  FolderOpen,
  ChevronRight,
  ChevronDown,
  Plus,
  Trash2,
  Edit2,
  Download,
  Upload,
  Globe,
  Check,
  X,
  Layers,
  Sparkles,
  Loader2,
  Search,
} from 'lucide-react'
import { FilterInput } from '../../../components/FilterInput'
import { compileQuery, queryMatches } from '../../../lib/query-match'
import { splitByRanges } from '../../../lib/fuzzy'
import { t } from '../../../lib/i18n'
import { toast } from './toast'
import {
  buildLibraryTree,
  extractItemName,
  useExcalidrawLibraryStore,
} from './library-store'
import { ExcalidrawOfficialLibraryModal } from './ExcalidrawOfficialLibraryModal'
import { loadExcalidrawLib, restoreSceneElements } from '../../../lib/markdown/excalidraw/loader'
import type {
  ExcalidrawLibraryFolder,
  ExcalidrawLibraryItem,
  LibraryFolderNode,
} from './types'

interface ExcalidrawLibraryTreeProps {
  api: any
  lib?: any
}

const previewCache = new Map<string, string>()

interface StencilItemPreviewProps {
  item: ExcalidrawLibraryItem
  lib?: any
  api?: any
}

const StencilItemPreview: React.FC<StencilItemPreviewProps> = ({ item, lib, api }) => {
  const [svgHtml, setSvgHtml] = useState<string | null>(() => {
    if (item.svgPreview) return item.svgPreview
    return previewCache.get(item.id) || null
  })
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (item.svgPreview) {
      setSvgHtml(item.svgPreview)
      previewCache.set(item.id, item.svgPreview)
      return
    }

    const cached = previewCache.get(item.id)
    if (cached) {
      setSvgHtml(cached)
      return
    }

    let active = true
    const generate = async () => {
      const activeLib = lib || (typeof window !== 'undefined' ? (window as any).ExcalidrawLib : null)
      if (!activeLib || typeof activeLib.exportToSvg !== 'function') return
      if (!item.elements || item.elements.length === 0) return

      setLoading(true)
      try {
        const isDark = typeof document !== 'undefined' && document.documentElement.dataset.theme === 'dark'
        const restored = activeLib.restoreElements ? activeLib.restoreElements(item.elements, null) : item.elements
        const svg = await activeLib.exportToSvg({
          elements: restored,
          appState: {
            exportBackground: false,
            viewBackgroundColor: 'transparent',
            exportWithDarkMode: isDark,
          },
          files: api?.getFiles ? api.getFiles() : {},
          skipInliningFonts: true,
        })
        if (!active || !svg) return
        svg.style.maxWidth = '100%'
        svg.style.maxHeight = '100%'
        svg.style.width = 'auto'
        svg.style.height = 'auto'
        svg.style.objectFit = 'contain'
        const html = svg.outerHTML
        previewCache.set(item.id, html)
        setSvgHtml(html)
      } catch {
      } finally {
        if (active) setLoading(false)
      }
    }

    generate()
    return () => {
      active = false
    }
  }, [item.id, item.svgPreview, item.elements, lib, api])

  if (svgHtml) {
    return (
      <div
        className="w-full h-full flex items-center justify-center p-0.5 pointer-events-none select-none [&>svg]:max-w-full [&>svg]:max-h-full [&>svg]:w-auto [&>svg]:h-auto [&>svg]:object-contain"
        dangerouslySetInnerHTML={{ __html: svgHtml }}
      />
    )
  }

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center gap-1 text-[var(--text-tertiary)]">
        <Loader2 size={16} className="animate-spin text-[var(--accent)]" />
      </div>
    )
  }

  return (
    <div className="text-[var(--text-quaternary)] flex flex-col items-center gap-1">
      <Layers size={20} />
      <span className="text-[10px] tabular-nums">{item.elements?.length || 0}</span>
    </div>
  )
}

function insertItemToCanvas(item: ExcalidrawLibraryItem, api: any) {
  if (!api || !item.elements || item.elements.length === 0) return
  const appState = api.getAppState ? api.getAppState() : {}
  const zoom = appState?.zoom?.value || 1
  const scrollX = appState?.scrollX || 0
  const scrollY = appState?.scrollY || 0
  const width = appState?.width || window.innerWidth
  const height = appState?.height || window.innerHeight

  const centerX = -scrollX + width / (2 * zoom)
  const centerY = -scrollY + height / (2 * zoom)

  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const el of item.elements) {
    if (typeof el.x === 'number' && typeof el.y === 'number') {
      minX = Math.min(minX, el.x)
      minY = Math.min(minY, el.y)
      maxX = Math.max(maxX, el.x + (el.width || 0))
      maxY = Math.max(maxY, el.y + (el.height || 0))
    }
  }

  const itemW = Number.isFinite(maxX - minX) ? maxX - minX : 100
  const itemH = Number.isFinite(maxY - minY) ? maxY - minY : 100
  const offsetX = centerX - minX - itemW / 2
  const offsetY = centerY - minY - itemH / 2

  const now = Date.now()
  const idMap = new Map<string, string>()
  for (const el of item.elements) {
    idMap.set(el.id, `el-${now}-${Math.random().toString(36).slice(2, 7)}`)
  }

  const cloned = item.elements.map((el) => {
    const newId = idMap.get(el.id) || `el-${now}-${Math.random().toString(36).slice(2, 7)}`
    const copy = { ...el, id: newId, x: el.x + offsetX, y: el.y + offsetY }
    if (Array.isArray(copy.boundElements)) {
      copy.boundElements = copy.boundElements.map((b: any) => ({
        ...b,
        id: idMap.get(b.id) || b.id,
      }))
    }
    if (copy.containerId) {
      copy.containerId = idMap.get(copy.containerId) || copy.containerId
    }
    return copy
  })

  const existing = api.getSceneElements ? api.getSceneElements() : []
  api.updateScene({
    elements: restoreSceneElements(api, [...existing, ...cloned]),
    appState: {
      selectedElementIds: Object.fromEntries(cloned.map((e) => [e.id, true])),
    },
  })
}

function itemMatchesQuery(
  item: ExcalidrawLibraryItem,
  compiledQuery: ReturnType<typeof compileQuery>,
  folders: ExcalidrawLibraryFolder[],
): boolean {
  if (!compiledQuery.text) return true
  if (queryMatches(compiledQuery, item.name)) return true
  const extracted = extractItemName(item)
  if (extracted && extracted !== item.name && queryMatches(compiledQuery, extracted)) {
    return true
  }
  if (Array.isArray(item.elements)) {
    for (const el of item.elements) {
      if (el) {
        const text = String(el.text || el.rawText || '').trim()
        if (text && queryMatches(compiledQuery, text)) return true
        if (el?.customData?.name && queryMatches(compiledQuery, String(el.customData.name))) return true
        if (el?.label?.text && queryMatches(compiledQuery, String(el.label.text))) return true
      }
    }
  }
  if (item.folderId) {
    const folder = folders.find((f) => f.id === item.folderId)
    if (folder && queryMatches(compiledQuery, folder.name)) return true
  }
  return false
}

export const ExcalidrawLibraryTree: React.FC<ExcalidrawLibraryTreeProps> = ({
  api,
  lib,
}) => {
  const [activeLib, setActiveLib] = useState<any>(
    lib || (typeof window !== 'undefined' ? (window as any).ExcalidrawLib : null),
  )

  useEffect(() => {
    if (lib) {
      setActiveLib(lib)
      return
    }
    loadExcalidrawLib()
      .then((l) => setActiveLib(l))
      .catch(() => {})
  }, [lib])
  const folders = useExcalidrawLibraryStore((s) => s.folders)
  const items = useExcalidrawLibraryStore((s) => s.items)
  const activeFolderId = useExcalidrawLibraryStore((s) => s.activeFolderId)
  const expandedFolderIds = useExcalidrawLibraryStore((s) => s.expandedFolderIds)
  const init = useExcalidrawLibraryStore((s) => s.init)
  const setActiveFolderId = useExcalidrawLibraryStore((s) => s.setActiveFolderId)
  const toggleFolder = useExcalidrawLibraryStore((s) => s.toggleFolder)
  const createFolder = useExcalidrawLibraryStore((s) => s.createFolder)
  const renameFolder = useExcalidrawLibraryStore((s) => s.renameFolder)
  const deleteFolder = useExcalidrawLibraryStore((s) => s.deleteFolder)
  const addItem = useExcalidrawLibraryStore((s) => s.addItem)
  const deleteItem = useExcalidrawLibraryStore((s) => s.deleteItem)
  const renameItem = useExcalidrawLibraryStore((s) => s.renameItem)
  const exportFolder = useExcalidrawLibraryStore((s) => s.exportFolder)
  const exportAll = useExcalidrawLibraryStore((s) => s.exportAll)
  const importFromLibraryData = useExcalidrawLibraryStore((s) => s.importFromLibraryData)

  const [searchText, setSearchText] = useState('')
  const [modalOpen, setModalOpen] = useState(false)
  const [editingFolderId, setEditingFolderId] = useState<string | null>(null)
  const [editingFolderName, setEditingFolderName] = useState('')
  const [editingItemId, setEditingItemId] = useState<string | null>(null)
  const [editingItemName, setEditingItemName] = useState('')
  const [addingToFolderId, setAddingToFolderId] = useState<string | null>(null)
  const [newSubfolderName, setNewSubfolderName] = useState('')

  const fileInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    void init()
  }, [init])

  const compiledQuery = useMemo(() => compileQuery(searchText), [searchText])
  const tree = useMemo(() => buildLibraryTree(folders, items), [folders, items])

  const visibleFolders = useMemo(() => {
    if (!searchText.trim()) return tree
    function filterNode(node: LibraryFolderNode): LibraryFolderNode | null {
      const nameMatch = queryMatches(compiledQuery, node.name)
      const matchingChildren: LibraryFolderNode[] = []
      for (const child of node.children) {
        const filteredChild = filterNode(child)
        if (filteredChild) matchingChildren.push(filteredChild)
      }
      const hasMatchingItems = items.some(
        (it) => it.folderId === node.id && itemMatchesQuery(it, compiledQuery, folders),
      )
      if (nameMatch || matchingChildren.length > 0 || hasMatchingItems) {
        return {
          ...node,
          children: matchingChildren,
        }
      }
      return null
    }

    const res: LibraryFolderNode[] = []
    for (const root of tree) {
      const f = filterNode(root)
      if (f) res.push(f)
    }
    return res
  }, [tree, searchText, compiledQuery, items, folders])

  const displayedItems = useMemo(() => {
    let list = items
    if (activeFolderId) {
      list = list.filter((it) => it.folderId === activeFolderId)
    }
    if (searchText.trim()) {
      list = list.filter((it) => itemMatchesQuery(it, compiledQuery, folders))
    }
    return list
  }, [items, activeFolderId, searchText, compiledQuery, folders])

  const otherMatchesCount = useMemo(() => {
    if (!searchText.trim() || !activeFolderId) return 0
    return items.filter(
      (it) => it.folderId !== activeFolderId && itemMatchesQuery(it, compiledQuery, folders),
    ).length
  }, [items, activeFolderId, searchText, compiledQuery, folders])

  const handleCreateSubfolder = (parentId: string | null) => {
    const name = newSubfolderName.trim() || t('excalidraw.new_folder')
    createFolder(name, parentId)
    setAddingToFolderId(null)
    setNewSubfolderName('')
  }

  const handleAddSelectedToLibrary = async () => {
    if (!api) return
    const selected = api.getSelectedElements ? api.getSelectedElements() : []
    if (selected.length === 0) {
      toast({
        title: t('excalidraw.add_selected_to_library'),
        description: t('excalidraw.no_elements_warning'),
        tone: 'danger',
      })
      return
    }

    let svgPreview: string | undefined
    if (activeLib && typeof activeLib.exportToSvg === 'function') {
      try {
        const isDark = typeof document !== 'undefined' && document.documentElement.dataset.theme === 'dark'
        const restored = activeLib.restoreElements ? activeLib.restoreElements(selected, null) : selected
        const svg = await activeLib.exportToSvg({
          elements: restored,
          appState: {
            exportBackground: false,
            viewBackgroundColor: 'transparent',
            exportWithDarkMode: isDark,
          },
          files: api.getFiles ? api.getFiles() : {},
          skipInliningFonts: true,
        })
        if (svg) {
          svg.style.maxWidth = '100%'
          svg.style.maxHeight = '100%'
          svg.style.width = 'auto'
          svg.style.height = 'auto'
          svg.style.objectFit = 'contain'
          svgPreview = svg.outerHTML
        }
      } catch {
      }
    }

    const target = activeFolderId || folders[0]?.id || null
    const item = addItem(target, selected, undefined, svgPreview)
    toast({
      title: t('excalidraw.imported'),
      description: item.name,
      tone: 'success',
    })
  }

  const handleLocalFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    try {
      const text = await file.text()
      const parsed = JSON.parse(text)
      const count = await importFromLibraryData(parsed, activeFolderId, file.name)
      toast({
        title: t('excalidraw.import_success', { value0: count }),
        tone: 'success',
      })
    } catch (err: any) {
      toast({
        title: t('excalidraw.import_failed'),
        description: err?.message || String(err),
        tone: 'danger',
      })
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  const renderFolderItem = (node: LibraryFolderNode) => {
    const isExpanded = expandedFolderIds.includes(node.id) || Boolean(searchText.trim())
    const isActive = activeFolderId === node.id
    const isEditing = editingFolderId === node.id
    const hasChildren = node.children.length > 0
    const match = searchText.trim() ? queryMatches(compiledQuery, node.name) : null

    return (
      <div key={node.id} className="flex flex-col select-none">
        <div
          onClick={() => setActiveFolderId(isActive ? null : node.id)}
          className={`group relative flex h-8 items-center gap-1 rounded-md px-1 text-xs cursor-pointer transition-colors ${
            isActive
              ? 'bg-[var(--accent)]/15 text-[var(--accent)] font-medium'
              : 'text-[var(--text-primary)] hover:bg-[var(--bg-hover)]'
          }`}
          style={{ paddingLeft: `${6 + node.depth * 14}px` }}
        >
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              toggleFolder(node.id)
            }}
            className={`p-0.5 rounded hover:bg-black/5 dark:hover:bg-white/5 text-[var(--text-tertiary)] ${
              !hasChildren ? 'invisible' : ''
            }`}
          >
            {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </button>

          {isActive ? (
            <FolderOpen size={15} className="shrink-0 text-[var(--accent)]" />
          ) : (
            <Folder size={15} className="shrink-0 text-[var(--text-tertiary)]" />
          )}

          {isEditing ? (
            <div className="flex items-center gap-1 flex-1 min-w-0" onClick={(e) => e.stopPropagation()}>
              <input
                type="text"
                value={editingFolderName}
                autoFocus
                onChange={(e) => setEditingFolderName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    renameFolder(node.id, editingFolderName)
                    setEditingFolderId(null)
                  } else if (e.key === 'Escape') {
                    setEditingFolderId(null)
                  }
                }}
                className="h-6 w-full rounded border border-[var(--accent)] bg-[var(--bg-surface)] px-1.5 text-xs text-[var(--text-primary)] focus:outline-none"
              />
              <button
                type="button"
                onClick={() => {
                  renameFolder(node.id, editingFolderName)
                  setEditingFolderId(null)
                }}
                className="p-1 text-[var(--accent)] hover:opacity-80"
              >
                <Check size={12} />
              </button>
            </div>
          ) : (
            <span className="flex-1 truncate ml-0.5">
              {match
                ? splitByRanges(node.name, match.ranges).map(
                    (part: { text: string; hit: boolean }, i: number) =>
                      part.hit ? (
                        <span key={i} className="font-semibold text-[var(--accent)]">
                          {part.text}
                        </span>
                      ) : (
                        <span key={i}>{part.text}</span>
                      ),
                  )
                : node.name}
            </span>
          )}

          <span className="text-[10.5px] tabular-nums text-[var(--text-quaternary)] mr-1">
            {node.itemCount}
          </span>

          <div
            className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              title={t('excalidraw.new_subfolder')}
              onClick={() => {
                setAddingToFolderId(node.id)
                setNewSubfolderName('')
              }}
              className="p-1 text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-black/5 dark:hover:bg-white/5 rounded"
            >
              <Plus size={12} />
            </button>
            <button
              type="button"
              title={t('sidebar.rename')}
              onClick={() => {
                setEditingFolderId(node.id)
                setEditingFolderName(node.name)
              }}
              className="p-1 text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-black/5 dark:hover:bg-white/5 rounded"
            >
              <Edit2 size={12} />
            </button>
            <button
              type="button"
              title={t('common.delete')}
              onClick={() => deleteFolder(node.id)}
              className="p-1 text-[var(--text-tertiary)] hover:text-[var(--danger)] hover:bg-black/5 dark:hover:bg-white/5 rounded"
            >
              <Trash2 size={12} />
            </button>
          </div>
        </div>

        {addingToFolderId === node.id && (
          <div
            className="flex items-center gap-1 py-1 pr-2 my-0.5 rounded-md bg-[var(--bg-sunken)]"
            style={{ paddingLeft: `${24 + node.depth * 14}px` }}
          >
            <input
              type="text"
              autoFocus
              placeholder={t('excalidraw.new_subfolder')}
              value={newSubfolderName}
              onChange={(e) => setNewSubfolderName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleCreateSubfolder(node.id)
                else if (e.key === 'Escape') setAddingToFolderId(null)
              }}
              className="h-6 flex-1 rounded border border-[var(--border-default)] bg-[var(--bg-surface)] px-1.5 text-xs text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent)]"
            />
            <button
              type="button"
              onClick={() => handleCreateSubfolder(node.id)}
              className="p-1 text-[var(--accent)]"
            >
              <Check size={13} />
            </button>
            <button
              type="button"
              onClick={() => setAddingToFolderId(null)}
              className="p-1 text-[var(--text-tertiary)]"
            >
              <X size={13} />
            </button>
          </div>
        )}

        {isExpanded && node.children.map((child) => renderFolderItem(child))}
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full w-full bg-[var(--bg-surface)] text-[var(--text-primary)] overflow-hidden">
      <div className="flex flex-col gap-2 p-3 border-b border-[var(--border-subtle)] shrink-0">
        <FilterInput
          value={searchText}
          onChange={setSearchText}
          query={compiledQuery}
          label={t('excalidraw.library_search_placeholder')}
          placeholder={t('excalidraw.library_search_placeholder')}
          size="sidebar"
          className="w-full"
        />

        <div className="flex items-center justify-between gap-1 pt-1">
          <div className="flex items-center gap-1 min-w-0">
            <button
              type="button"
              onClick={() => {
                setAddingToFolderId('root')
                setNewSubfolderName('')
              }}
              title={t('excalidraw.new_folder')}
              className="flex items-center gap-1.5 h-7 px-2 rounded-md bg-[var(--bg-sunken)] hover:bg-[var(--bg-hover)] text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors border border-[var(--border-subtle)] shrink-0"
            >
              <FolderPlus size={13} className="text-[var(--accent)] shrink-0" />
              <span className="whitespace-nowrap">{t('excalidraw.new_folder')}</span>
            </button>
          </div>

          <div className="flex items-center gap-1 shrink-0">
            <button
              type="button"
              onClick={handleAddSelectedToLibrary}
              title={t('excalidraw.add_selected_to_library')}
              className="h-7 w-7 rounded-md bg-[var(--bg-sunken)] hover:bg-[var(--bg-hover)] text-[var(--text-secondary)] hover:text-[var(--accent)] transition-colors border border-[var(--border-subtle)] flex items-center justify-center shrink-0"
            >
              <Plus size={14} />
            </button>

            <button
              type="button"
              onClick={() => setModalOpen(true)}
              title={t('excalidraw.browse_official_libraries')}
              className="h-7 w-7 rounded-md bg-[var(--bg-sunken)] hover:bg-[var(--bg-hover)] text-[var(--text-secondary)] hover:text-[var(--accent)] transition-colors border border-[var(--border-subtle)] flex items-center justify-center"
            >
              <Globe size={14} />
            </button>

            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              title={t('excalidraw.import_from_file')}
              className="h-7 w-7 rounded-md bg-[var(--bg-sunken)] hover:bg-[var(--bg-hover)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors border border-[var(--border-subtle)] flex items-center justify-center"
            >
              <Upload size={14} />
            </button>

            <button
              type="button"
              onClick={() => (activeFolderId ? exportFolder(activeFolderId) : exportAll())}
              title={activeFolderId ? t('excalidraw.export_folder') : t('excalidraw.export_library')}
              className="h-7 w-7 rounded-md bg-[var(--bg-sunken)] hover:bg-[var(--bg-hover)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors border border-[var(--border-subtle)] flex items-center justify-center"
            >
              <Download size={14} />
            </button>

            <input
              ref={fileInputRef}
              type="file"
              accept=".excalidrawlib,.json"
              className="hidden"
              onChange={handleLocalFileChange}
            />
          </div>
        </div>

        {addingToFolderId === 'root' && (
          <div className="flex items-center gap-1 py-1 px-2 rounded-md bg-[var(--bg-sunken)] border border-[var(--border-default)]">
            <input
              type="text"
              autoFocus
              placeholder={t('excalidraw.new_folder')}
              value={newSubfolderName}
              onChange={(e) => setNewSubfolderName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleCreateSubfolder(null)
                else if (e.key === 'Escape') setAddingToFolderId(null)
              }}
              className="h-6 flex-1 rounded border border-[var(--border-default)] bg-[var(--bg-surface)] px-1.5 text-xs text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent)]"
            />
            <button
              type="button"
              onClick={() => handleCreateSubfolder(null)}
              className="p-1 text-[var(--accent)]"
            >
              <Check size={13} />
            </button>
            <button
              type="button"
              onClick={() => setAddingToFolderId(null)}
              className="p-1 text-[var(--text-tertiary)]"
            >
              <X size={13} />
            </button>
          </div>
        )}
      </div>

      <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
        <div className="p-2 border-b border-[var(--border-subtle)]/70 max-h-[40%] overflow-y-auto">
          <div
            onClick={() => setActiveFolderId(null)}
            className={`flex h-8 items-center gap-2 rounded-md px-2 text-xs cursor-pointer transition-colors ${
              activeFolderId === null
                ? 'bg-[var(--accent)]/15 text-[var(--accent)] font-medium'
                : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]'
            }`}
          >
            <Layers size={15} />
            <span className="flex-1">{t('excalidraw.all_folders')}</span>
            <span className="text-[10.5px] tabular-nums text-[var(--text-quaternary)]">
              {items.length}
            </span>
          </div>

          <div className="mt-1 flex flex-col gap-0.5">
            {visibleFolders.map((folderNode) => renderFolderItem(folderNode))}
          </div>
        </div>

        <div className="flex-1 min-h-0 flex flex-col overflow-hidden bg-[var(--bg-sunken)]/40 p-3">
          <div className="flex items-center justify-between pb-2 text-xs text-[var(--text-tertiary)]">
            <span>
              {activeFolderId
                ? folders.find((f) => f.id === activeFolderId)?.name || t('excalidraw.library_title')
                : t('excalidraw.all_folders')}
            </span>
            <span>{t('excalidraw.item_count', { value0: displayedItems.length })}</span>
          </div>

          <div className="flex-1 min-h-0 overflow-y-auto">
            {displayedItems.length === 0 ? (
              searchText.trim() ? (
                <div className="flex flex-col items-center justify-center h-44 text-center gap-2 text-xs text-[var(--text-secondary)] px-4">
                  <Search size={22} className="opacity-50 text-[var(--accent)] mb-1" />
                  <p className="font-medium text-[var(--text-primary)]">
                    {activeFolderId
                      ? t('excalidraw.no_match_in_current_folder')
                      : t('excalidraw.no_match_stencils')}
                  </p>
                  {otherMatchesCount > 0 && (
                    <button
                      type="button"
                      onClick={() => setActiveFolderId(null)}
                      className="mt-2 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-[var(--accent)] text-white text-xs font-medium hover:opacity-90 transition-opacity cursor-pointer"
                    >
                      <Layers size={13} />
                      <span>{t('excalidraw.view_all_folder_results', { value0: otherMatchesCount })}</span>
                    </button>
                  )}
                </div>
              ) : (
                <div className="flex flex-col items-center justify-center h-40 text-center gap-2 text-xs text-[var(--text-quaternary)] px-4">
                  <Sparkles size={24} className="opacity-40" />
                  <p>{t('excalidraw.no_items_in_folder')}</p>
                  <button
                    type="button"
                    onClick={() => setModalOpen(true)}
                    className="mt-1 inline-flex items-center gap-1 px-3 py-1.5 rounded-md bg-[var(--accent)] text-white text-xs font-medium hover:opacity-90"
                  >
                    <Globe size={13} />
                    <span>{t('excalidraw.browse_official_libraries')}</span>
                  </button>
                </div>
              )
            ) : (
              <div className="grid grid-cols-2 gap-2.5">
                {displayedItems.map((item, idx) => {
                  const isItemEditing = editingItemId === item.id
                  const itemTitle =
                    !item.name || /^(stencil|item)\s*\d+$/i.test(item.name.trim())
                      ? extractItemName(item, idx, item.name || 'Item')
                      : item.name
                  return (
                    <div
                      key={item.id}
                      draggable
                      onDragStart={(e) => {
                        e.dataTransfer.setData(
                          'application/vnd.excalidrawlib.elements',
                          JSON.stringify(item.elements),
                        )
                      }}
                      onClick={() => insertItemToCanvas(item, api)}
                      className="group relative flex flex-col rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-2 hover:border-[var(--accent)] hover:shadow-xs cursor-pointer transition-all gap-1.5"
                      title={t('excalidraw.click_to_insert')}
                    >
                      <div className="h-20 w-full flex items-center justify-center bg-[var(--bg-sunken)]/60 rounded overflow-hidden p-1">
                        <StencilItemPreview item={item} lib={activeLib} api={api} />
                      </div>

                      {isItemEditing ? (
                        <div
                          className="flex items-center gap-1 pt-0.5"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <input
                            type="text"
                            autoFocus
                            value={editingItemName}
                            onChange={(e) => setEditingItemName(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') {
                                renameItem(item.id, editingItemName)
                                setEditingItemId(null)
                              } else if (e.key === 'Escape') {
                                setEditingItemId(null)
                              }
                            }}
                            className="h-5 w-full rounded border border-[var(--accent)] bg-[var(--bg-surface)] px-1 text-[11px] text-[var(--text-primary)] focus:outline-none"
                          />
                          <button
                            type="button"
                            onClick={() => {
                              renameItem(item.id, editingItemName)
                              setEditingItemId(null)
                            }}
                            className="text-[var(--accent)]"
                          >
                            <Check size={11} />
                          </button>
                        </div>
                      ) : (
                        <span
                          className="text-xs truncate text-[var(--text-secondary)] group-hover:text-[var(--text-primary)] font-medium"
                          title={itemTitle}
                        >
                          {itemTitle}
                        </span>
                      )}

                      <div
                        className="absolute top-1.5 right-1.5 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity bg-[var(--bg-surface)]/90 backdrop-blur-xs rounded shadow-xs p-0.5"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <button
                          type="button"
                          title={t('excalidraw.rename_item')}
                          onClick={() => {
                            setEditingItemId(item.id)
                            setEditingItemName(itemTitle)
                          }}
                          className="p-1 rounded text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-black/5"
                        >
                          <Edit2 size={11} />
                        </button>
                        <button
                          type="button"
                          title={t('excalidraw.delete_library_item')}
                          onClick={() => deleteItem(item.id)}
                          className="p-1 rounded text-[var(--text-tertiary)] hover:text-[var(--danger)] hover:bg-black/5"
                        >
                          <Trash2 size={11} />
                        </button>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        </div>
      </div>

      <ExcalidrawOfficialLibraryModal
        isOpen={modalOpen}
        onClose={() => setModalOpen(false)}
        targetFolderId={activeFolderId}
      />
    </div>
  )
}

export const ExcalidrawLibraryPortal: React.FC<{
  api: any
  lib?: any
  hostRef?: React.RefObject<HTMLDivElement | null>
  /**
   * Whether the engine's library sidebar is open, which the surface already learns from the engine's
   * own onChange. Watching the canvas subtree for the slot instead meant a querySelector on every DOM
   * change the engine makes mid-drag, and the observer never disconnected while the sidebar was closed
   * because the slot it was looking for never existed.
   */
  open: boolean
}> = ({ api, lib, hostRef, open }) => {
  const [container, setContainer] = useState<Element | null>(null)

  useEffect(() => {
    if (!open) {
      setContainer(null)
      return
    }
    let cancelled = false
    let left = 40
    const locate = () => {
      if (cancelled) return
      const root = hostRef?.current ?? document
      const target = root.querySelector('.layer-ui__library')
      if (target) {
        setContainer(target)
        return
      }
      if (--left <= 0) return
      window.setTimeout(locate, 50)
    }
    locate()
    return () => {
      cancelled = true
    }
  }, [open, hostRef])

  if (!open || !container || !container.isConnected) return null

  return createPortal(
    <div data-ink-library-tree="true" className="h-full w-full flex flex-col overflow-hidden">
      <ExcalidrawLibraryTree api={api} lib={lib} />
    </div>,
    container,
  )
}

