import { useEffect, useState } from 'react'
import { Download, RefreshCw, Trash2, Undo2 } from 'lucide-react'
import type { QrCodeRecord } from '../../../../../shared/tools/qrcode/types'
import { deleteQrRecord, fetchQrRecords } from '../api'
import { useQrCodeStore } from '../store'
import { useToolsStore } from '../../store'
import { Button, IconButton } from '../../../../components/primitives'
import { confirm } from '../../../../components/overlay'
import { useUi } from '../../../../store/ui'
import { t } from '../../../../lib/i18n'

export function QrHistoryView() {
  const [records, setRecords] = useState<QrCodeRecord[]>([])
  const [loading, setLoading] = useState(false)

  const setActiveView = useQrCodeStore((s) => s.setActiveView)
  const setContentType = useQrCodeStore((s) => s.setContentType)
  const setTextContent = useQrCodeStore((s) => s.setTextContent)
  const setUrlContent = useQrCodeStore((s) => s.setUrlContent)
  const setOptions = useQrCodeStore((s) => s.setOptions)

  const loadRecords = async () => {
    setLoading(true)
    try {
      const data = await fetchQrRecords({ limit: 50 })
      setRecords(data.items ?? (data as any).records ?? [])
    } catch {
      useUi.getState().toast({ title: t('tools.qrcode.history.load_error'), tone: 'danger' })
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadRecords()
  }, [])

  const handleRestore = (record: QrCodeRecord) => {
    setContentType(record.contentType)
    if (record.contentType === 'url') {
      setUrlContent(record.contentRaw)
    } else {
      setTextContent(record.contentRaw)
    }
    try {
      const parsedOptions = JSON.parse(record.optionsJson)
      setOptions(parsedOptions)
    } catch {
    }
    setActiveView('generator')
    useToolsStore.getState().setActiveQrCodeView('generator')
    useUi.getState().toast({ title: t('tools.qrcode.history.restored'), tone: 'success' })
  }

  const handleDelete = async (record: QrCodeRecord) => {
    const confirmed = await confirm({
      title: t('tools.qrcode.history.delete_confirm_title'),
      description: t('tools.qrcode.history.delete_confirm_desc'),
      confirmLabel: t('tools.qrcode.history.delete_confirm_button'),
      tone: 'danger',
    })
    if (!confirmed) return

    try {
      await deleteQrRecord(record.id)
      setRecords((prev) => prev.filter((r) => r.id !== record.id))
      useUi.getState().toast({ title: t('tools.qrcode.history.delete_success'), tone: 'success' })
    } catch {
      useUi.getState().toast({ title: t('tools.qrcode.history.delete_error'), tone: 'danger' })
    }
  }

  return (
    <div className="flex h-full flex-col p-4 overflow-y-auto">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-[length:var(--text-16)] font-semibold text-[var(--text-primary)]">
            {t('tools.qrcode.history.title')}
          </h2>
          <p className="text-[length:var(--text-12)] text-[var(--text-secondary)]">
            {t('tools.qrcode.history.subtitle')}
          </p>
        </div>
        <Button
          variant="secondary"
          size="sm"
          onClick={loadRecords}
          loading={loading}
          icon={<RefreshCw size={14} />}
        >
          {t('tools.qrcode.history.refresh')}
        </Button>
      </div>

      {!records || records.length === 0 && !loading ? (
        <div className="flex flex-1 flex-col items-center justify-center text-center p-8 text-[var(--text-tertiary)]">
          <p className="text-[length:var(--text-14)]">{t('tools.qrcode.history.empty')}</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
          {records?.map((record) => (
            <div
              key={record.id}
              className="flex flex-col rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] p-3 shadow-xs"
            >
              <div className="flex items-center justify-between mb-2">
                <span className="text-[length:var(--text-11)] font-semibold uppercase text-[var(--accent)]">
                  {record.contentType}
                </span>
                <span className="text-[length:var(--text-10)] text-[var(--text-tertiary)]">
                  {new Date(record.createdAt).toLocaleDateString()}
                </span>
              </div>

              <div className="flex items-center justify-center bg-white rounded p-2 mb-2 h-36 overflow-hidden">
                <img
                  src={`/api/tools/qrcode/records/${record.id}/file`}
                  alt={record.title}
                  className="h-full object-contain"
                />
              </div>

              <div className="truncate text-[length:var(--text-12)] font-medium text-[var(--text-primary)] mb-1">
                {record.title || record.contentRaw}
              </div>

              <div className="flex items-center justify-between pt-2 border-t border-[var(--border-subtle)] mt-auto">
                <Button
                  variant="subtle"
                  size="sm"
                  onClick={() => handleRestore(record)}
                  icon={<Undo2 size={13} />}
                >
                  {t('tools.qrcode.history.edit_again')}
                </Button>

                <div className="flex items-center gap-1">
                  <a
                    href={`/api/tools/qrcode/records/${record.id}/file`}
                    download={`qrcode-${record.id}.${record.fileType}`}
                    className="inline-flex"
                  >
                    <IconButton size="sm" label={t('tools.qrcode.history.download')}>
                      <Download size={14} />
                    </IconButton>
                  </a>
                  <IconButton
                    size="sm"
                    label={t('tools.qrcode.history.delete')}
                    onClick={() => handleDelete(record)}
                  >
                    <Trash2 size={14} className="text-[var(--danger)]" />
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
