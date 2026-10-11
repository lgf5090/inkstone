import React, { useEffect, useMemo, useState } from 'react'
import {
  Download,
  FolderInput,
  Globe,
  Loader2,
  UploadCloud,
  X,
  Check,
  ExternalLink,
} from 'lucide-react'
import { FilterInput } from '../../../components/FilterInput'
import { compileQuery, queryMatches } from '../../../lib/query-match'
import { api } from '../../../lib/api'
import { t } from '../../../lib/i18n'
import { toast } from './toast'
import { useExcalidrawLibraryStore } from './library-store'
import type { OfficialLibraryEntry } from './types'

interface ExcalidrawOfficialLibraryModalProps {
  isOpen: boolean
  onClose: () => void
  targetFolderId: string | null
}

export const ExcalidrawOfficialLibraryModal: React.FC<ExcalidrawOfficialLibraryModalProps> = ({
  isOpen,
  onClose,
  targetFolderId,
}) => {
  const folders = useExcalidrawLibraryStore((s) => s.folders)
  const importFromLibraryData = useExcalidrawLibraryStore((s) => s.importFromLibraryData)

  const [activeTab, setActiveTab] = useState<'online' | 'local' | 'web'>('online')
  const [catalog, setCatalog] = useState<OfficialLibraryEntry[]>([])
  const [loadingCatalog, setLoadingCatalog] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [selectedFolder, setSelectedFolder] = useState<string | null>(targetFolderId)
  const [importingSource, setImportingSource] = useState<string | null>(null)
  const [importedSources, setImportedSources] = useState<Set<string>>(new Set())
  const [failedPreviews, setFailedPreviews] = useState<Set<string>>(new Set())

  const [localFile, setLocalFile] = useState<File | null>(null)
  const [localFileLoading, setLocalFileLoading] = useState(false)
  const [urlInput, setUrlInput] = useState('')
  const [urlLoading, setUrlLoading] = useState(false)

  const officialSiteUrl = useMemo(() => {
    if (typeof window === 'undefined') return 'https://libraries.excalidraw.com/'
    const currentBase = window.location.origin + window.location.pathname
    const token = `inkstone_${Math.random().toString(36).slice(2, 10)}`
    return `https://libraries.excalidraw.com/?target=_excalidraw&referrer=${encodeURIComponent(currentBase)}&useHash=true&token=${token}&theme=light&version=2&sort=default`
  }, [])

  useEffect(() => {
    setSelectedFolder(targetFolderId)
  }, [targetFolderId])

  useEffect(() => {
    if (!isOpen) return
    let mounted = true
    setLoadingCatalog(true)
    api.excalidrawLibrary
      .getOfficialCatalog()
      .then((res) => {
        if (!mounted) return
        if (res.ok && Array.isArray(res.libraries)) {
          setCatalog(res.libraries)
        }
      })
      .catch((err) => {
        if (!mounted) return
        console.error('Failed to load official catalog:', err)
      })
      .finally(() => {
        if (mounted) setLoadingCatalog(false)
      })
    return () => {
      mounted = false
    }
  }, [isOpen])

  useEffect(() => {
    const handleHash = async () => {
      if (typeof window === 'undefined') return
      const hash = window.location.hash
      if (!hash.includes('addLibrary=')) return
      const match = hash.match(/addLibrary=([^&#]+)/)
      if (!match || !match[1]) return
      const libraryUrl = decodeURIComponent(match[1])
      window.history.replaceState(null, '', window.location.pathname + window.location.search)

      try {
        setUrlLoading(true)
        const res = await api.excalidrawLibrary.downloadOfficialLibrary(libraryUrl)
        if (res.ok && res.data) {
          const libraryName = res.filename?.replace(/\.excalidrawlib$/i, '') || 'Official Library'
          const count = await importFromLibraryData(res.data, selectedFolder, libraryName)
          toast({
            title: t('excalidraw.import_success', { value0: count }),
            tone: 'success',
          })
          if (isOpen) {
            onClose()
          }
        }
      } catch (err: any) {
        toast({
          title: t('excalidraw.import_failed'),
          description: err?.message || String(err),
          tone: 'danger',
        })
      } finally {
        setUrlLoading(false)
      }
    }

    handleHash()
    window.addEventListener('hashchange', handleHash)
    return () => {
      window.removeEventListener('hashchange', handleHash)
    }
  }, [isOpen, selectedFolder, importFromLibraryData, onClose])

  useEffect(() => {
    if (!isOpen) return
    const handleMessage = async (event: MessageEvent) => {
      if (
        event.origin.includes('excalidraw.com') &&
        event.data &&
        (event.data.type === 'excalidraw-library-install' || event.data.libraryItems)
      ) {
        try {
          const count = await importFromLibraryData(
            event.data.libraryItems || event.data,
            selectedFolder,
            event.data.name || 'Official Library',
          )
          toast({
            title: t('excalidraw.import_success', { value0: count }),
            tone: 'success',
          })
          onClose()
        } catch {
        }
      }
    }
    window.addEventListener('message', handleMessage)
    return () => {
      window.removeEventListener('message', handleMessage)
    }
  }, [isOpen, selectedFolder, importFromLibraryData, onClose])

  const compiledQuery = useMemo(() => compileQuery(searchQuery), [searchQuery])

  const filteredCatalog = useMemo(() => {
    if (!compiledQuery.text) return catalog
    return catalog.filter((item) => {
      return (
        queryMatches(compiledQuery, item.name) ||
        queryMatches(compiledQuery, item.description || '') ||
        queryMatches(compiledQuery, item.authors?.[0]?.name || '')
      )
    })
  }, [catalog, compiledQuery])

  const handleImportOfficial = async (item: OfficialLibraryEntry) => {
    setImportingSource(item.source)
    try {
      const res = await api.excalidrawLibrary.downloadOfficialLibrary(item.source)
      if (res.ok && res.data) {
        const count = await importFromLibraryData(res.data, selectedFolder, item.name)
        setImportedSources((prev) => new Set([...prev, item.source]))
        toast({
          title: t('excalidraw.import_success', { value0: count }),
          tone: 'success',
        })
      } else {
        throw new Error('Download returned empty data')
      }
    } catch (err: any) {
      toast({
        title: t('excalidraw.import_failed'),
        description: err?.message || String(err),
        tone: 'danger',
      })
    } finally {
      setImportingSource(null)
    }
  }

  const handleImportLocalFile = async () => {
    if (!localFile) return
    setLocalFileLoading(true)
    try {
      const text = await localFile.text()
      const parsed = JSON.parse(text)
      const count = await importFromLibraryData(parsed, selectedFolder, localFile.name)
      await api.excalidrawLibrary.saveFile(localFile.name, text)
      toast({
        title: t('excalidraw.import_success', { value0: count }),
        tone: 'success',
      })
      setLocalFile(null)
      onClose()
    } catch (err: any) {
      toast({
        title: t('excalidraw.import_failed'),
        description: err?.message || String(err),
        tone: 'danger',
      })
    } finally {
      setLocalFileLoading(false)
    }
  }

  const handleImportUrl = async () => {
    const raw = urlInput.trim()
    if (!raw) return
    setUrlLoading(true)
    try {
      let downloadTarget = raw
      let name = 'Imported Library'

      if (raw.includes('addLibrary=')) {
        try {
          const match = raw.match(/addLibrary=([^&#]+)/)
          if (match && match[1]) {
            downloadTarget = decodeURIComponent(match[1])
          }
        } catch {
        }
      }

      if (
        downloadTarget.includes('libraries.excalidraw.com') &&
        !downloadTarget.includes('/libraries/') &&
        !downloadTarget.endsWith('.excalidrawlib') &&
        !downloadTarget.endsWith('.json')
      ) {
        toast({
          title: t('excalidraw.token_missing_addlibrary'),
          tone: 'danger',
        })
        return
      }

      const matched = catalog.find(
        (it) =>
          it.id === raw ||
          it.name.toLowerCase() === raw.toLowerCase() ||
          it.source.toLowerCase() === raw.toLowerCase(),
      )
      if (matched) {
        downloadTarget = matched.source
        name = matched.name
      } else if (!downloadTarget.startsWith('http') && !downloadTarget.includes('/')) {
        if (/^[a-zA-Z0-9_-]+$/.test(downloadTarget)) {
          toast({
            title: t('excalidraw.token_missing_addlibrary'),
            tone: 'danger',
          })
          return
        }
      }

      const res = await api.excalidrawLibrary.downloadOfficialLibrary(downloadTarget)
      if (res.ok && res.data) {
        const libraryName = matched?.name || res.filename?.replace(/\.excalidrawlib$/i, '') || name
        const count = await importFromLibraryData(res.data, selectedFolder, libraryName)
        toast({
          title: t('excalidraw.import_success', { value0: count }),
          tone: 'success',
        })
        setUrlInput('')
        onClose()
      } else {
        throw new Error('Failed to download library')
      }
    } catch (err: any) {
      toast({
        title: t('excalidraw.import_failed'),
        description: err?.message || String(err),
        tone: 'danger',
      })
    } finally {
      setUrlLoading(false)
    }
  }

  if (!isOpen) return null

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60 backdrop-blur-xs p-4 animate-in fade-in duration-150">
      <div className="relative flex flex-col h-[88vh] max-h-[820px] w-full max-w-4xl rounded-xl border border-[var(--border-default)] bg-[var(--bg-surface)] text-[var(--text-primary)] shadow-2xl overflow-hidden">
        <header className="flex h-14 shrink-0 items-center justify-between border-b border-[var(--border-subtle)] px-6 bg-[var(--bg-sunken)]">
          <div className="flex items-center gap-3">
            <Globe size={20} className="text-[var(--accent)]" />
            <h2 className="text-base font-semibold text-[var(--text-primary)]">{t('excalidraw.browse_official_libraries')}</h2>
          </div>

          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2 text-xs text-[var(--text-secondary)]">
              <FolderInput size={14} />
              <span>{t('excalidraw.import_to_folder')}:</span>
              <select
                value={selectedFolder || ''}
                onChange={(e) => setSelectedFolder(e.target.value || null)}
                className="h-7 rounded border border-[var(--border-default)] bg-[var(--bg-surface)] px-2 text-xs text-[var(--text-primary)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)]"
              >
                <option value="">{t('excalidraw.all_folders')}</option>
                {folders.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                  </option>
                ))}
              </select>
            </div>

            <button
              type="button"
              onClick={onClose}
              className="rounded-md p-1.5 text-[var(--text-tertiary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors"
            >
              <X size={18} />
            </button>
          </div>
        </header>

        <div className="flex border-b border-[var(--border-subtle)] px-6 gap-6 text-sm font-medium bg-[var(--bg-surface)]">
          <button
            type="button"
            onClick={() => setActiveTab('online')}
            className={`py-3 border-b-2 transition-colors ${
              activeTab === 'online'
                ? 'border-[var(--accent)] text-[var(--accent)]'
                : 'border-transparent text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
            }`}
          >
            {t('excalidraw.online_libraries')}
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('local')}
            className={`py-3 border-b-2 transition-colors ${
              activeTab === 'local'
                ? 'border-[var(--accent)] text-[var(--accent)]'
                : 'border-transparent text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
            }`}
          >
            {t('excalidraw.local_file')}
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('web')}
            className={`py-3 border-b-2 transition-colors ${
              activeTab === 'web'
                ? 'border-[var(--accent)] text-[var(--accent)]'
                : 'border-transparent text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
            }`}
          >
            {t('excalidraw.web_import')}
          </button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto p-6">
          {activeTab === 'online' && (
            <div className="flex flex-col h-full gap-4">
              <FilterInput
                value={searchQuery}
                onChange={setSearchQuery}
                query={compiledQuery}
                label={t('excalidraw.official_catalog_search')}
                placeholder={t('excalidraw.official_catalog_search')}
                size="panel"
                className="w-full"
              />

              {loadingCatalog && (
                <div className="flex flex-1 items-center justify-center py-20 text-[var(--text-secondary)] gap-2 text-sm">
                  <Loader2 size={18} className="animate-spin text-[var(--accent)]" />
                  <span>{t('preview.excalidraw_loading')}</span>
                </div>
              )}

              {!loadingCatalog && filteredCatalog.length === 0 && (
                <div className="flex flex-1 items-center justify-center py-20 text-[var(--text-tertiary)] text-sm">
                  {t('excalidraw.no_match_stencils')}
                </div>
              )}

              {!loadingCatalog && filteredCatalog.length > 0 && (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {filteredCatalog.map((item) => {
                    const isImported = importedSources.has(item.source)
                    const isBusy = importingSource === item.source
                    const hasFailed = failedPreviews.has(item.source)
                    const previewUrl = !hasFailed && item.preview
                      ? item.preview.startsWith('http')
                        ? item.preview
                        : `https://libraries.excalidraw.com/libraries/${item.preview.replace(/^\/+/, '')}`
                      : null

                    return (
                      <div
                        key={item.source}
                        className="flex flex-col justify-between p-4 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-sunken)] hover:border-[var(--border-default)] transition-colors gap-3"
                      >
                        <div className="flex gap-3 min-w-0">
                          {previewUrl ? (
                            <img
                              src={previewUrl}
                              alt={item.name}
                              className="w-20 h-20 object-contain rounded bg-white p-1 border border-black/5 shrink-0"
                              loading="lazy"
                              onError={() => setFailedPreviews((prev) => new Set([...prev, item.source]))}
                            />
                          ) : (
                            <div className="w-20 h-20 rounded bg-[var(--bg-surface)] border border-[var(--border-subtle)] flex items-center justify-center text-[var(--text-quaternary)] shrink-0">
                              <Globe size={24} />
                            </div>
                          )}

                          <div className="flex flex-col min-w-0 flex-1">
                            <h3 className="font-semibold text-sm truncate text-[var(--text-primary)]" title={item.name}>
                              {item.name}
                            </h3>
                            {item.authors?.[0]?.name && (
                              <p className="text-xs text-[var(--text-tertiary)] mt-0.5 truncate">
                                @{item.authors[0].name}
                              </p>
                            )}
                            {item.description && (
                              <p className="text-xs text-[var(--text-secondary)] mt-1 line-clamp-2 leading-relaxed">
                                {item.description}
                              </p>
                            )}
                            {typeof item.totalDownloads === 'number' && (
                              <p className="text-[11px] text-[var(--text-quaternary)] mt-auto pt-1 flex items-center gap-1">
                                <Download size={11} />
                                <span>
                                  {item.totalDownloads} {t('excalidraw.downloads')}
                                </span>
                              </p>
                            )}
                          </div>
                        </div>

                        <div className="flex items-center justify-end pt-2 border-t border-[var(--border-subtle)]/60">
                          <button
                            type="button"
                            disabled={isBusy}
                            onClick={() => handleImportOfficial(item)}
                            className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                              isImported
                                ? 'bg-[var(--bg-surface)] text-[var(--accent)] border border-[var(--accent)]/40'
                                : 'bg-[var(--accent)] text-white hover:opacity-90 disabled:opacity-50'
                            }`}
                          >
                            {isBusy ? (
                              <>
                                <Loader2 size={13} className="animate-spin" />
                                <span>{t('excalidraw.importing')}</span>
                              </>
                            ) : isImported ? (
                              <>
                                <Check size={13} />
                                <span>{t('excalidraw.imported')}</span>
                              </>
                            ) : (
                              <>
                                <Download size={13} />
                                <span>{t('excalidraw.one_click_import')}</span>
                              </>
                            )}
                          </button>
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          )}

          {activeTab === 'local' && (
            <div className="flex flex-col items-center justify-center h-full max-w-lg mx-auto gap-6 py-10">
              <label className="flex flex-col items-center justify-center w-full h-52 border-2 border-dashed border-[var(--border-default)] rounded-xl bg-[var(--bg-sunken)] hover:bg-[var(--bg-surface)] cursor-pointer transition-colors p-6 text-center">
                <UploadCloud size={36} className="text-[var(--accent)] mb-3" />
                <span className="text-sm font-medium text-[var(--text-primary)]">
                  {localFile ? localFile.name : t('excalidraw.drop_file_here')}
                </span>
                <span className="text-xs text-[var(--text-tertiary)] mt-1">
                  {t('excalidraw.file_limit_hint')}
                </span>
                <input
                  type="file"
                  accept=".excalidrawlib,.json"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0]
                    if (f) setLocalFile(f)
                  }}
                />
              </label>

              <button
                type="button"
                disabled={!localFile || localFileLoading}
                onClick={handleImportLocalFile}
                className="w-full h-10 rounded-lg bg-[var(--accent)] text-white font-medium text-sm flex items-center justify-center gap-2 hover:opacity-90 disabled:opacity-40 transition-opacity"
              >
                {localFileLoading ? (
                  <>
                    <Loader2 size={16} className="animate-spin" />
                    <span>{t('excalidraw.importing')}</span>
                  </>
                ) : (
                  <>
                    <Download size={16} />
                    <span>{t('excalidraw.one_click_import')}</span>
                  </>
                )}
              </button>
            </div>
          )}

          {activeTab === 'web' && (
            <div className="flex flex-col h-full max-w-lg mx-auto gap-6 py-8">
              <div className="rounded-lg p-4 border border-[var(--border-subtle)] bg-[var(--bg-sunken)] text-xs text-[var(--text-secondary)] leading-relaxed flex flex-col gap-2">
                <p>
                  {t('excalidraw.web_import_desc')}
                </p>
                <a
                  href={officialSiteUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1.5 text-[var(--accent)] hover:underline font-medium pt-1"
                >
                  <ExternalLink size={13} />
                  <span>{t('excalidraw.open_official_site')}</span>
                </a>
              </div>

              <div className="flex flex-col gap-2">
                <label className="text-xs font-medium text-[var(--text-secondary)]">
                  {t('excalidraw.url_or_token')}
                </label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={urlInput}
                    onChange={(e) => setUrlInput(e.target.value)}
                    placeholder="https://libraries.excalidraw.com/..."
                    className="flex-1 h-10 px-3 rounded-lg border border-[var(--border-default)] bg-[var(--bg-sunken)] text-sm text-[var(--text-primary)] focus:bg-[var(--bg-surface)] focus:border-[var(--accent)] focus:outline-none"
                  />
                  <button
                    type="button"
                    disabled={!urlInput.trim() || urlLoading}
                    onClick={handleImportUrl}
                    className="px-5 h-10 rounded-lg bg-[var(--accent)] text-white text-sm font-medium hover:opacity-90 disabled:opacity-40 transition-opacity flex items-center gap-1.5"
                  >
                    {urlLoading ? <Loader2 size={15} className="animate-spin" /> : <Download size={15} />}
                    <span>{t('excalidraw.one_click_import')}</span>
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
