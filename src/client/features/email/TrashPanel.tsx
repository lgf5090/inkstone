import { useEffect, useState } from 'react'
import { RotateCcw, Trash2 } from 'lucide-react'
import { EMAIL_PAGE_SIZE, EMAIL_TRASH_RETENTION_DAYS, type EmailSummary } from '@shared/email/model'
import { Button, IconButton } from '../../components/primitives'
import { Modal, confirm } from '../../components/overlay'
import { t } from '../../lib/i18n'
import { useUi } from '../../store/ui'
import { emailErrorText } from './errors'
import { messageDateLabel, messageSubject, senderLabel } from './format'
import { Pager } from './Pager'
import { useEmailStore } from './store'

function reportFailure(error: unknown): void {
  useUi.getState().toast({ title: t('email.toast.failed'), description: emailErrorText(error), tone: 'danger' })
}

export function TrashPanel({ open, accountId, onClose }: {
  open: boolean
  accountId: string
  onClose: () => void
}) {
  const trash = useEmailStore((state) => state.trash)
  const total = useEmailStore((state) => state.trashTotal)
  const status = useEmailStore((state) => state.trashStatus)
  const error = useEmailStore((state) => state.trashError)
  const page = useEmailStore((state) => state.trashPage)
  const loadTrash = useEmailStore((state) => state.loadTrash)
  const restoreTrash = useEmailStore((state) => state.restoreTrash)
  const purgeTrash = useEmailStore((state) => state.purgeTrash)
  const emptyTrash = useEmailStore((state) => state.emptyTrash)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [clearing, setClearing] = useState(false)

  useEffect(() => {
    if (!open) return
    void loadTrash(accountId, 1)
  }, [open, accountId, loadTrash])

  const restore = async (message: EmailSummary): Promise<void> => {
    setBusyId(message.id)
    try {
      await restoreTrash(accountId, message.id)
      useUi.getState().toast({ title: t('email.trash.restored'), tone: 'success' })
    } catch (reason) {
      reportFailure(reason)
    } finally {
      setBusyId(null)
    }
  }

  const purge = async (message: EmailSummary): Promise<void> => {
    const ok = await confirm({
      title: t('email.trash.purge_title', { subject: messageSubject(message) }),
      description: t('email.trash.purge_hint'),
      confirmLabel: t('email.trash.permanently_delete'),
      tone: 'danger',
    })
    if (!ok) return
    setBusyId(message.id)
    try {
      await purgeTrash(accountId, message.id)
      useUi.getState().toast({ title: t('email.trash.purged'), tone: 'success' })
    } catch (reason) {
      reportFailure(reason)
    } finally {
      setBusyId(null)
    }
  }

  const clear = async (): Promise<void> => {
    const ok = await confirm({
      title: t('email.trash.clear_title'),
      description: t('email.trash.clear_hint'),
      confirmLabel: t('email.trash.clear'),
      tone: 'danger',
    })
    if (!ok) return
    setClearing(true)
    try {
      await emptyTrash(accountId)
      useUi.getState().toast({ title: t('email.trash.cleared'), tone: 'success' })
      onClose()
    } catch (reason) {
      reportFailure(reason)
    } finally {
      setClearing(false)
    }
  }

  const pageCount = Math.max(1, Math.ceil(total / EMAIL_PAGE_SIZE))
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('email.trash.title')}
      description={t('email.trash.description', { days: EMAIL_TRASH_RETENTION_DAYS })}
      width={560}
      footer={(
        <>
          <Button variant="ghost" onClick={onClose}>{t('common.close')}</Button>
          <Button
            variant="danger"
            loading={clearing}
            disabled={trash.length === 0 || status !== 'ready'}
            onClick={() => { void clear() }}
          >
            {t('email.trash.clear')}
          </Button>
        </>
      )}
    >
      {status === 'loading' && trash.length === 0 && (
        <p role="status" className="py-6 text-center text-[length:var(--text-12)] text-[var(--text-tertiary)]">{t('common.loading')}</p>
      )}
      {status === 'error' && (
        <div className="flex flex-col items-center gap-2 py-6">
          <p role="alert" className="text-center text-[length:var(--text-12)] text-[var(--text-tertiary)]">{error}</p>
          <Button size="sm" variant="ghost" onClick={() => { void loadTrash(accountId, page) }}>{t('common.retry')}</Button>
        </div>
      )}
      {status === 'ready' && trash.length === 0 && (
        <p role="status" className="py-6 text-center text-[length:var(--text-12)] text-[var(--text-tertiary)]">{t('email.trash.empty')}</p>
      )}
      {trash.length > 0 && (
        <ul className="m-0 list-none p-0">
          {trash.map((message, index) => (
            <li key={message.id} className={index > 0 ? 'border-t border-[var(--border-subtle)]' : undefined}>
              <div className="flex min-h-12 items-center gap-2 py-1.5">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[length:var(--text-13)] text-[var(--text-primary)]">{messageSubject(message)}</p>
                  <p className="truncate text-[length:var(--text-11)] text-[var(--text-quaternary)]">
                    {senderLabel(message.sender)} · {messageDateLabel(message.date)}
                  </p>
                </div>
                <IconButton
                  label={t('email.trash.restore_subject', { subject: messageSubject(message) })}
                  size="sm"
                  disabled={busyId === message.id}
                  onClick={() => { void restore(message) }}
                >
                  <RotateCcw size={14} />
                </IconButton>
                <IconButton
                  label={t('email.trash.delete_subject', { subject: messageSubject(message) })}
                  size="sm"
                  disabled={busyId === message.id}
                  onClick={() => { void purge(message) }}
                >
                  <Trash2 size={14} />
                </IconButton>
              </div>
            </li>
          ))}
        </ul>
      )}
      <Pager
        page={page}
        pageCount={pageCount}
        onPage={(next) => { void loadTrash(accountId, next) }}
        label={t('email.trash.pagination')}
      />
    </Modal>
  )
}
