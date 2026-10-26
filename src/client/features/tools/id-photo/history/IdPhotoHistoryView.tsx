import { useEffect, useState } from 'react'
import { Download, History, RotateCcw, Trash2 } from 'lucide-react'
import type { IdPhotoRecord } from '@shared/tools/id-photo/types'
import { t } from '../../../../lib/i18n'
import { Button, IconButton } from '../../../../components/primitives'
import { useUi } from '../../../../store/ui'
import { useToolsStore } from '../../store'
import { useIdPhotoStore } from '../store'
import { deleteIdPhotoRecord, listIdPhotoRecords } from '../api'

export function IdPhotoHistoryView() {
  const [records, setRecords] = useState<IdPhotoRecord[]>([])
  const [loading, setLoading] = useState(true)

  const setSelectedSpecId = useIdPhotoStore((s) => s.setSelectedSpecId)
  const setAdjustOptions = useIdPhotoStore((s) => s.setAdjustOptions)
  const setImageSrc = useIdPhotoStore((s) => s.setImageSrc)
  const setActiveIdPhotoView = useToolsStore((s) => s.setActiveIdPhotoView)

  const loadRecords = async () => {
    setLoading(true)
    try {
      const res = await listIdPhotoRecords()
      setRecords(res.records)
    } catch {
      // ignore
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadRecords()
  }, [])

  const handleDelete = async (id: string) => {
    try {
      await deleteIdPhotoRecord(id)
      setRecords((prev) => prev.filter((r) => r.id !== id))
      useUi.getState().toast({
        title: t('tools.id_photo.history.delete_success'),
        tone: 'default',
      })
    } catch {
      useUi.getState().toast({
        title: t('tools.id_photo.history.delete_failed'),
        tone: 'danger',
      })
    }
  }

  const handleLoadEdit = (record: IdPhotoRecord) => {
    try {
      setSelectedSpecId(record.specId)
      const parsedOptions = JSON.parse(record.optionsJson)
      setAdjustOptions({
        ...parsedOptions,
        specId: record.specId,
        bgColor: record.bgColor,
      })
      setImageSrc(`/api/tools/id-photo/records/${record.id}/file`)
      setActiveIdPhotoView('studio')
    } catch {
      // fallback
    }
  }

  return (
    <div className="flex h-full min-h-0 w-full flex-col overflow-y-auto p-4 sm:p-6 max-w-5xl mx-auto gap-5">
      {/* Header */}
      <div className="flex items-center justify-between pb-3 border-b border-[var(--border-subtle)]">
        <div className="flex items-center gap-2.5">
          <div className="flex h-10 w-10 items-center justify-center rounded-[var(--r-md)] bg-[var(--accent-soft)] text-[var(--accent)]">
            <History size={22} />
          </div>
          <div>
            <h2 className="text-[length:var(--text-16)] font-semibold text-[var(--text-primary)]">
              {t('tools.id_photo.history.title')}
            </h2>
            <p className="text-[length:var(--text-12)] text-[var(--text-tertiary)]">
              {records.length} {t('tools.id_photo.common.archived_count')}
            </p>
          </div>
        </div>
      </div>

      {/* History Grid */}
      {records.length === 0 && !loading ? (
        <div className="flex flex-col items-center justify-center gap-2 py-16 text-center text-[var(--text-tertiary)]">
          <History size={36} />
          <p className="text-[length:var(--text-13)]">
            {t('tools.id_photo.history.empty')}
          </p>
        </div>
      ) : (
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
                  onClick={() => handleLoadEdit(record)}
                >
                  <RotateCcw size={12} className="mr-1" />
                  <span>{t('tools.id_photo.history.load_edit')}</span>
                </Button>

                <div className="flex items-center gap-1">
                  <a
                    href={`/api/tools/id-photo/records/${record.id}/file`}
                    download
                    className="flex h-7 w-7 items-center justify-center rounded-[var(--r-sm)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]"
                  >
                    <Download size={14} />
                  </a>
                  <IconButton
                    size="sm"
                    variant="danger"
                    label={t('tools.id_photo.common.delete')}
                    onClick={() => handleDelete(record.id)}
                  >
                    <Trash2 size={13} />
                  </IconButton>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
