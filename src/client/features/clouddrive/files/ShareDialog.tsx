import { useEffect, useState } from 'react'
import { LIMITS } from '@shared/constants'
import type { CloudDriveEntry } from '@shared/clouddrive/model'
import { t } from '../../../lib/i18n'
import { Button } from '../../../components/primitives'
import { Checkbox, Field, Input } from '../../../components/form'
import { Modal } from '../../../components/overlay'
import type { ShareOptions } from './useFileActions'

export interface ShareDialogProps {
  open: boolean
  entries: CloudDriveEntry[]
  busy: boolean
  onClose: () => void
  onSubmit: (options: ShareOptions) => Promise<boolean>
}

export function ShareDialog({ open, entries, busy, onClose, onSubmit }: ShareDialogProps) {
  const [password, setPassword] = useState('')
  const [expiresDays, setExpiresDays] = useState('0')
  const [maxViews, setMaxViews] = useState('0')
  const [maxDownloads, setMaxDownloads] = useState('0')
  const [allowDownload, setAllowDownload] = useState(true)

  useEffect(() => {
    if (!open) return
    setPassword('')
    setExpiresDays('0')
    setMaxViews('0')
    setMaxDownloads('0')
    setAllowDownload(true)
  }, [open])

  const passwordTooShort = password.length > 0 && password.length < LIMITS.sharePasscodeMinLength

  const submit = async () => {
    if (passwordTooShort) return
    const ok = await onSubmit({
      password: password.trim() || undefined,
      expiresDays: Number(expiresDays) || 0,
      maxViews: Number(maxViews) || 0,
      maxDownloads: Number(maxDownloads) || 0,
      allowDownload,
    })
    if (ok) onClose()
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('clouddrive.share.create_title')}
      width={460}
      footer={(
        <>
          <Button variant="ghost" onClick={onClose}>{t('clouddrive.dialog.cancel')}</Button>
          <Button variant="primary" loading={busy} disabled={entries.length === 0 || passwordTooShort} onClick={() => void submit()}>
            {t('clouddrive.share.create')}
          </Button>
        </>
      )}
    >
      <div className="grid gap-2">
        <p className="text-[length:var(--text-11-5)] leading-relaxed text-[var(--text-tertiary)]">
          {t('clouddrive.share.create_body', { count: entries.length })}
        </p>
        <Field label={t('clouddrive.share.password_label')} hint={t('clouddrive.share.password_hint', { min: LIMITS.sharePasscodeMinLength })}>
          <Input
            type="password"
            value={password}
            minLength={LIMITS.sharePasscodeMinLength}
            maxLength={LIMITS.passwordMaxLength}
            aria-invalid={passwordTooShort || undefined}
            onChange={(event) => setPassword(event.target.value)}
          />
        </Field>
        <Field label={t('clouddrive.share.expires_days')}>
          <Input type="number" min={0} value={expiresDays} onChange={(event) => setExpiresDays(event.target.value)} />
        </Field>
        <Field label={t('clouddrive.share.max_views')}>
          <Input type="number" min={0} value={maxViews} onChange={(event) => setMaxViews(event.target.value)} />
        </Field>
        <Field label={t('clouddrive.share.max_downloads')}>
          <Input type="number" min={0} value={maxDownloads} onChange={(event) => setMaxDownloads(event.target.value)} />
        </Field>
        <Checkbox checked={allowDownload} label={t('clouddrive.share.allow_download')} onChange={setAllowDownload} />
      </div>
    </Modal>
  )
}
