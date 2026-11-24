import { useCallback, useEffect, useState } from 'react'
import { RotateCcw } from 'lucide-react'
import { formatBytes } from '@shared/byte-format'
import { OFFICE_LIMITS } from '@shared/office/constants'
import type { OfficeFileSummary, OfficeVersionSummary } from '@shared/office/model'
import { useLocale, t } from '../../lib/i18n'
import { Button, Spinner } from '../../components/primitives'
import { Modal } from '../../components/overlay'
import { useUi } from '../../store/ui'
import { officeApi, officeErrorText } from './api'

export interface OfficeVersionsProps {
  open: boolean
  file: OfficeFileSummary | null
  onClose: () => void
  onRestored: (rev: number) => void
}

export function OfficeVersions({ open, file, onClose, onRestored }: OfficeVersionsProps) {
  const locale = useLocale()
  const toast = useUi((state) => state.toast)
  const [versions, setVersions] = useState<OfficeVersionSummary[]>([])
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [error, setError] = useState<string | null>(null)
  const [restoring, setRestoring] = useState<number | null>(null)

  const load = useCallback(async (fileId: string) => {
    setStatus('loading')
    setError(null)
    try {
      const result = await officeApi.versions(fileId)
      setVersions(result.versions)
      setStatus('ready')
    } catch (caught) {
      setError(officeErrorText(caught))
      setStatus('error')
    }
  }, [])

  useEffect(() => {
    if (!open || !file) return
    void load(file.id)
  }, [open, file, load])

  const restore = async (version: OfficeVersionSummary) => {
    if (!file) return
    setRestoring(version.rev)
    try {
      await officeApi.restoreVersion(file.id, version.rev)
      toast({ title: t('office.versions.restored'), tone: 'success' })
      onRestored(version.rev)
      await load(file.id)
    } catch (caught) {
      toast({ title: t('office.toast.failed'), description: officeErrorText(caught), tone: 'danger' })
    } finally {
      setRestoring(null)
    }
  }

  const dateFormat = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' })

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('office.versions.title')}
      width={520}
      footer={<Button variant="ghost" onClick={onClose}>{t('common.close')}</Button>}
    >
      <div className="flex flex-col gap-2">
        <p className="text-[length:var(--text-11-5)] leading-relaxed text-[var(--text-tertiary)]">
          {t('office.versions.description', { count: OFFICE_LIMITS.versionsPerFile })}
        </p>
        {status === 'loading' && (
          <div className="flex h-24 items-center justify-center"><Spinner /></div>
        )}
        {status === 'error' && (
          <div role="alert" className="flex flex-col items-center gap-2 py-4">
            <p className="text-[length:var(--text-12)] text-[var(--text-secondary)]">{t('office.error.load')}</p>
            {error && <p className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">{error}</p>}
            <Button size="sm" variant="secondary" onClick={() => { if (file) void load(file.id) }}>
              {t('office.error.retry')}
            </Button>
          </div>
        )}
        {status === 'ready' && versions.length === 0 && (
          <p className="py-4 text-center text-[length:var(--text-12)] text-[var(--text-tertiary)]">{t('office.versions.empty')}</p>
        )}
        {versions.length > 0 && (
          <ul className="flex flex-col gap-1">
            {versions.map((version) => {
              // The newest version is the current one: after a restore the file prop still carries the
              // revision the editor opened at, which is no longer the head of the list.
              const current = versions[0]?.rev === version.rev
              return (
                <li key={version.rev} className="flex min-w-0 items-center gap-2 rounded-[var(--r-md)] border border-[var(--border-subtle)] px-2.5 py-1.5">
                  <span className="shrink-0 rounded-full bg-[var(--bg-inset)] px-2 py-0.5 text-[length:var(--text-10)] tabular text-[var(--text-tertiary)]">
                    {`v${version.rev}`}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[length:var(--text-11)] text-[var(--text-secondary)]">
                    {dateFormat.format(version.createdAt)} · {formatBytes(version.size)}
                  </span>
                  {current && (
                    <span className="shrink-0 text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">{t('office.versions.current')}</span>
                  )}
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={current || restoring !== null}
                    loading={restoring === version.rev}
                    icon={<RotateCcw size={13} />}
                    onClick={() => void restore(version)}
                  >
                    {t('office.versions.restore')}
                  </Button>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </Modal>
  )
}