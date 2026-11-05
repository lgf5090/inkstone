import { useEffect, useState } from 'react'
import { Link2 } from 'lucide-react'
import type { CloudDriveUploadConflict } from '@shared/clouddrive/model'
import { t } from '../../../lib/i18n'
import { Button } from '../../../components/primitives'
import { Field, Input } from '../../../components/form'
import { Modal } from '../../../components/overlay'
import { useUi } from '../../../store/ui'
import { clouddriveApi } from '../api'
import { useCloudDriveStore } from '../store'

export interface RemoteUploadDialogProps {
  open: boolean
  path: string
  conflict: CloudDriveUploadConflict
  onClose: () => void
  /** A dismissed dialog is not a failure; the transfer centre reports the download. */
  onStarted: (entryPath: string) => void
}

export function RemoteUploadDialog({ open, path, conflict, onClose, onStarted }: RemoteUploadDialogProps) {
  const toast = useUi((state) => state.toast)
  const bumpRefresh = useCloudDriveStore((state) => state.bumpRefresh)
  const [url, setUrl] = useState('')
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!open) return
    setUrl('')
    setName('')
    setBusy(false)
  }, [open])

  const submit = async () => {
    if (busy || url.trim().length === 0) return
    setBusy(true)
    try {
      const result = await clouddriveApi.uploadUrl({
        url: url.trim(),
        parentPath: path,
        name: name.trim() || undefined,
        conflict,
      })
      if (result.skipped) {
        toast({ title: t('clouddrive.upload_url.skipped') })
      } else if (result.entryPath) {
        toast({ title: t('clouddrive.upload_url.started', { name: result.entryPath.split('/').pop() ?? result.entryPath }) })
        onStarted(result.entryPath)
      }
      bumpRefresh()
      onClose()
    } catch (error) {
      toast({
        title: t('clouddrive.upload_url.failed'),
        description: error instanceof Error ? error.message : '',
        tone: 'danger',
      })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('clouddrive.upload_url.title')}
      width={460}
      footer={(
        <>
          <Button variant="ghost" onClick={onClose}>{t('clouddrive.dialog.cancel')}</Button>
          <Button variant="primary" loading={busy} disabled={url.trim().length === 0} onClick={() => void submit()}>
            <Link2 size={13} /> {t('clouddrive.upload_url.start')}
          </Button>
        </>
      )}
    >
      <div className="grid gap-2">
        <p className="text-[length:var(--text-11-5)] leading-relaxed text-[var(--text-tertiary)]">
          {t('clouddrive.upload_url.body')}
        </p>
        <Field label={t('clouddrive.upload_url.url')} required>
          <Input
            type="url"
            inputMode="url"
            value={url}
            placeholder={t('clouddrive.upload_url.url_placeholder')}
            onChange={(event) => setUrl(event.target.value)}
          />
        </Field>
        <Field label={t('clouddrive.upload_url.name')}>
          <Input value={name} maxLength={255} onChange={(event) => setName(event.target.value)} />
        </Field>
      </div>
    </Modal>
  )
}
