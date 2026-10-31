import { useEffect, useRef, useState } from 'react'
import { Download, History, Printer, RotateCcw, Search, Trash2 } from 'lucide-react'
import type { IdPhotoRecord } from '@shared/tools/id-photo/types'
import type { IdPhotoExportFormat } from '@shared/tools/id-photo/types'
import { t } from '../../../../lib/i18n'
import { Button, IconButton } from '../../../../components/primitives'
import { Input } from '../../../../components/form'
import { confirm } from '../../../../components/overlay'
import { useUi } from '../../../../store/ui'
import { useToolsStore } from '../../store'
import { useIdPhotoStore } from '../store'
import { deleteIdPhotoRecord, listIdPhotoRecords } from '../api'
import { IdPhotoOptionsPatchSchema } from '@shared/tools/id-photo/schemas'

const EXPORT_FORMATS = ['jpg', 'jpeg', 'png', 'webp'] as const

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

const PAGE_SIZE = 12

function downloadFile(href: string) {
  const anchor = document.createElement('a')
  anchor.href = href
  anchor.download = ''
  anchor.click()
}

export function IdPhotoHistoryView() {
  const [records, setRecords] = useState<IdPhotoRecord[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [failed, setFailed] = useState(false)
  const [search, setSearch] = useState('')
  const [query, setQuery] = useState('')
  const requestId = useRef(0)

  const setSelectedSpecId = useIdPhotoStore((s) => s.setSelectedSpecId)
  const setAdjustOptions = useIdPhotoStore((s) => s.setAdjustOptions)
  const setImageSrc = useIdPhotoStore((s) => s.setImageSrc)
  const setExportFormat = useIdPhotoStore((s) => s.setExportFormat)
  const setActiveIdPhotoView = useToolsStore((s) => s.setActiveIdPhotoView)

  const fetchPage = async (offset: number, term: string) => {
    const id = ++requestId.current
    const { records: page, total: count } = await listIdPhotoRecords({
      limit: PAGE_SIZE,
      offset,
      ...(term ? { search: term } : {}),
    })
    if (id !== requestId.current) return null
    return { page, offset, count }
  }

  const reload = async () => {
    setLoading(true)
    setFailed(false)
    try {
      const result = await fetchPage(0, query)
      if (!result) return
      setRecords(result.page)
      setTotal(result.count)
    } catch {
      setFailed(true)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (!query) {
      void reload()
      return
    }
    const timer = setTimeout(() => void reload(), 300)
    return () => clearTimeout(timer)
  }, [query])

  useEffect(() => {
    if (search.trim() === query) return
    const timer = setTimeout(() => setQuery(search.trim()), 300)
    return () => clearTimeout(timer)
  }, [search, query])

  const handleLoadMore = async () => {
    setLoadingMore(true)
    try {
      const result = await fetchPage(records.length, query)
      if (!result) return
      setRecords((prev) => [...prev, ...result.page])
      setTotal(result.count)
    } catch {
      useUi.getState().toast({ title: t('tools.id_photo.history.load_failed'), tone: 'danger' })
    } finally {
      setLoadingMore(false)
    }
  }

  const handleDelete = async (record: IdPhotoRecord) => {
    const confirmed = await confirm({
      title: t('tools.id_photo.history.delete_title'),
      description: t('tools.id_photo.history.delete_desc'),
      confirmLabel: t('tools.id_photo.common.delete'),
      cancelLabel: t('tools.id_photo.common.cancel'),
      tone: 'danger',
    })
    if (!confirmed) return

    try {
      const outcome = await deleteIdPhotoRecord(record.id)
      setRecords((prev) => prev.filter((item) => item.id !== record.id))
      setTotal((prev) => Math.max(0, prev - 1))
      useUi.getState().toast({
        title: outcome?.storageCleaned === false
          ? t('tools.id_photo.history.storage_pending')
          : t('tools.id_photo.history.delete_success'),
        tone: outcome?.storageCleaned === false ? 'warning' : 'default',
      })
    } catch {
      useUi.getState().toast({ title: t('tools.id_photo.history.delete_failed'), tone: 'danger' })
    }
  }

  const handleLoadEdit = async (record: IdPhotoRecord) => {
    setSelectedSpecId(record.specId)
    const parsed = IdPhotoOptionsPatchSchema.safeParse(safeJsonParse(record.optionsJson))
    if (!parsed.success) {
      useUi.getState().toast({ title: t('tools.id_photo.history.load_failed'), tone: 'danger' })
      return
    }
    setAdjustOptions({ ...parsed.data, specId: record.specId, bgColor: record.bgColor })
    if ((EXPORT_FORMATS as readonly string[]).includes(record.fileType)) {
      setExportFormat(record.fileType as IdPhotoExportFormat)
    }
    if (!(await setImageSrc(`/api/tools/id-photo/records/${record.id}/file`))) {
      useUi.getState().toast({ title: t('tools.id_photo.content.decode_failed'), tone: 'danger' })
    }
    setActiveIdPhotoView('studio')
  }

  return (
    <div className="flex h-full min-h-0 w-full flex-col overflow-y-auto p-4 sm:p-6 max-w-5xl mx-auto gap-5">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3 border-b border-[var(--border-subtle)]">
        <div className="flex items-center gap-2.5">
          <div className="flex h-10 w-10 items-center justify-center rounded-[var(--r-md)] bg-[var(--accent-soft)] text-[var(--accent-on-soft)]">
            <History size={22} />
          </div>
          <div>
            <h2 className="text-[length:var(--text-16)] font-semibold text-[var(--text-primary)]">
              {t('tools.id_photo.history.title')}
            </h2>
            <p className="text-[length:var(--text-12)] text-[var(--text-tertiary)]">
              {t('tools.id_photo.history.showing', { shown: records.length, total })}
            </p>
          </div>
        </div>

        <Input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder={t('tools.id_photo.history.search_placeholder')}
          aria-label={t('tools.id_photo.history.search_placeholder')}
          leading={<Search size={14} aria-hidden="true" />}
          className="w-full sm:w-64"
        />
      </div>

      {loading && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3" aria-busy="true">
          {Array.from({ length: 3 }).map((_, index) => (
            <div
              key={index}
              className="h-32 rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)]"
            />
          ))}
        </div>
      )}

      {!loading && failed && (
        <div className="flex flex-col items-start gap-2">
          <p className="text-[length:var(--text-13)] font-medium text-[var(--danger)]">
            {t('tools.id_photo.history.load_failed')}
          </p>
          <Button variant="secondary" onClick={() => {
            void reload()
          }}>
            <RotateCcw size={14} className="mr-1.5" />
            <span>{t('tools.id_photo.history.retry')}</span>
          </Button>
        </div>
      )}

      {!loading && !failed && records.length === 0 && (
        <div className="flex flex-col items-center justify-center gap-2 py-16 text-center text-[var(--text-tertiary)]">
          <History size={36} />
          <p className="text-[length:var(--text-13)]">{t('tools.id_photo.history.empty')}</p>
        </div>
      )}

      {!loading && !failed && records.length > 0 && (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {records.map((record) => (
              <div
                key={record.id}
                className="flex flex-col justify-between rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] p-3.5 shadow-xs"
              >
                <div className="flex items-start gap-3">
                  <div className="h-20 w-16 shrink-0 overflow-hidden rounded-[var(--r-sm)] border border-[var(--border-subtle)] bg-[var(--bg-base)]">
                    <img
                      src={`/api/tools/id-photo/records/${record.id}/file`}
                      alt={record.title}
                      width={record.widthPx}
                      height={record.heightPx}
                      loading="lazy"
                      decoding="async"
                      className="h-full w-full object-cover"
                    />
                  </div>

                  <div className="flex flex-col min-w-0 flex-1 gap-1">
                    <h4 className="truncate text-[length:var(--text-13)] font-semibold text-[var(--text-primary)]">
                      {record.title}
                    </h4>
                    <p className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">
                      {record.specName} ({record.widthPx}×{record.heightPx} {t('tools.id_photo.unit.px')})
                    </p>
                    <p className="text-[length:var(--text-10)] text-[var(--text-tertiary)] font-mono">
                      {new Date(record.createdAt).toLocaleDateString()}
                    </p>
                  </div>
                </div>

                <div className="flex items-center justify-between border-t border-[var(--border-subtle)] pt-2.5 mt-3">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      void handleLoadEdit(record)
                    }}
                  >
                    <RotateCcw size={12} className="mr-1" />
                    <span>{t('tools.id_photo.history.load_edit')}</span>
                  </Button>

                  <div className="flex items-center gap-1">
                    <IconButton
                      size="sm"
                      label={t('tools.id_photo.export.download_photo')}
                      onClick={() => downloadFile(`/api/tools/id-photo/records/${record.id}/file?download=1`)}
                    >
                      <Download size={14} />
                    </IconButton>
                    {record.printR2Key && (
                      <IconButton
                        size="sm"
                        label={t('tools.id_photo.export.download_print')}
                        onClick={() => downloadFile(`/api/tools/id-photo/records/${record.id}/print-file?download=1`)}
                      >
                        <Printer size={14} />
                      </IconButton>
                    )}
                    <IconButton
                      size="sm"
                      variant="danger"
                      label={t('tools.id_photo.common.delete')}
                      onClick={() => {
                        void handleDelete(record)
                      }}
                    >
                      <Trash2 size={13} />
                    </IconButton>
                  </div>
                </div>
              </div>
            ))}
          </div>

          {records.length < total && (
            <div className="flex justify-center pt-1">
              <Button
                variant="secondary"
                disabled={loadingMore}
                onClick={() => {
                  void handleLoadMore()
                }}
              >
                <span>{t('tools.id_photo.common.load_more')}</span>
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  )
}
