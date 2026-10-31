import { useEffect, useState } from 'react'
import { Download, Trash2 } from 'lucide-react'
import type { GithubExportFile } from '@shared/development/github/types'
import { EXPORT_TTL_MS } from '@shared/development/github/limits'
import { t } from '../../../../lib/i18n'
import { githubApi } from '../api'
import { formatDate, formatFileSize } from '../lib/format'
import { Button, IconButton, Spinner } from '../../../../components/primitives'
import { Empty } from '../../../../components/feedback'
import { Modal, confirm } from '../../../../components/overlay'
import { useUi } from '../../../../store/ui'

function remainingHours(file: GithubExportFile): number {
  return Math.max(0, Math.ceil((file.createdAt + EXPORT_TTL_MS - Date.now()) / 3_600_000))
}

export function ExportHistoryDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const toast = useUi((state) => state.toast)
  const [items, setItems] = useState<GithubExportFile[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = async () => {
    setLoading(true)
    setError(null)
    try {
      setItems(await githubApi.listExports())
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('development.github.common.load_failed'))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (open) void load()
  }, [open])

  const remove = async (file: GithubExportFile) => {
    const ok = await confirm({
      title: t('common.delete'),
      description: t('development.github.gists.export_delete_confirm', { name: file.filename }),
      confirmLabel: t('common.delete'),
      tone: 'danger',
    })
    if (!ok) return
    try {
      await githubApi.deleteExport(file.id)
      setItems((previous) => previous.filter((entry) => entry.id !== file.id))
      toast({ title: t('development.github.gists.export_deleted'), tone: 'success' })
    } catch (cause) {
      toast({
        title: t('development.github.gists.export_delete_failed'),
        description: cause instanceof Error ? cause.message : undefined,
        tone: 'danger',
      })
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('development.github.gists.exports_title')}
      description={t('development.github.gists.exports_desc')}
      width={560}
      footer={<Button variant="secondary" onClick={onClose}>{t('common.close')}</Button>}
    >
      {loading ? (
        <div className="flex items-center justify-center gap-2 py-10 text-[length:var(--text-12)] text-[var(--text-tertiary)]"><Spinner size={14} />{t('development.github.common.loading')}</div>
      ) : error ? (
        <div className="flex flex-col items-center gap-2 py-8 text-center">
          <p className="text-[length:var(--text-12)] text-[var(--danger)]" role="alert">{error}</p>
          <Button variant="secondary" size="sm" onClick={() => void load()}>{t('development.github.common.retry')}</Button>
        </div>
      ) : items.length === 0 ? (
        <Empty art="notes" title={t('development.github.gists.exports_empty')} />
      ) : (
        <ul className="divide-y divide-[var(--border-subtle)]">
          {items.map((file) => (
            <li key={file.id} className="flex items-center gap-2 py-2">
              <div className="min-w-0 flex-1">
                <p className="truncate text-[length:var(--text-12)] font-medium" title={file.filename}>{file.filename}</p>
                <p className="text-[length:var(--text-11)] text-[var(--text-quaternary)]">
                  {file.format.toUpperCase()} · {formatFileSize(file.size)} · {formatDate(new Date(file.createdAt).toISOString())}
                  {' · '}{t('development.github.gists.exports_remaining', { hours: remainingHours(file) })}
                </p>
              </div>
              <a
                href={githubApi.exportUrl(file.id)}
                download={file.filename}
                className="inline-flex size-8 shrink-0 items-center justify-center rounded-[var(--r-md)] text-[var(--text-tertiary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
                aria-label={t('development.github.gists.export_download')}
                title={t('development.github.gists.export_download')}
              >
                <Download size={13} />
              </a>
              <IconButton label={t('common.delete')} size="sm" onClick={() => void remove(file)}><Trash2 size={13} /></IconButton>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  )
}
