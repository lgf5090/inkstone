import { useCallback, useEffect, useState } from 'react'
import { Save, Trash2 } from 'lucide-react'
import type { CloudDrivePublicSettings, CloudDriveSettingsPatch } from '@shared/clouddrive/settings'
import { Button, Spinner } from '../../../components/primitives'
import { Field, Input, Switch } from '../../../components/form'
import { confirm } from '../../../components/overlay'
import { useUi } from '../../../store/ui'
import { clouddriveApi } from '../api'
import { ConfigBackupButton } from '../ConfigBackupButton'
import { ct } from '../media-i18n'

export function CloudDriveSettingsPage({ owner }: { owner: boolean }) {
  const toast = useUi((state) => state.toast)
  const [settings, setSettings] = useState<CloudDrivePublicSettings | null>(null)
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [saving, setSaving] = useState(false)
  const [purging, setPurging] = useState(false)
  const [webdavPassword, setWebdavPassword] = useState('')
  const [draft, setDraft] = useState<CloudDriveSettingsPatch>({})

  const load = useCallback(async () => {
    setStatus('loading')
    try {
      const result = await clouddriveApi.settings()
      setSettings(result.settings)
      setDraft({
        uploadMaxFileBytes: result.settings.uploadMaxFileBytes,
        uploadPartSizeBytes: result.settings.uploadPartSizeBytes,
        uploadConcurrentParts: result.settings.uploadConcurrentParts,
        uploadDistributedMinBytes: result.settings.uploadDistributedMinBytes,
        shareAllowMemberShares: result.settings.shareAllowMemberShares,
        shareDefaultExpiryDays: result.settings.shareDefaultExpiryDays,
        shareMaxExpiryDays: result.settings.shareMaxExpiryDays,
        trashRetentionDays: result.settings.trashRetentionDays,
        storageDisplayQuotaBytes: result.settings.storageDisplayQuotaBytes,
        webdavEnabled: result.settings.webdavEnabled,
        webdavUsername: result.settings.webdavUsername,
        adminOwnerCanViewMemberFiles: result.settings.adminOwnerCanViewMemberFiles,
      })
      setStatus('ready')
    } catch (error) {
      setStatus('error')
      toast({ title: ct('clouddrive.settings.load_failed'), description: error instanceof Error ? error.message : '', tone: 'danger' })
    }
  }, [toast])
  useEffect(() => { void load() }, [load])

  const save = async () => {
    setSaving(true)
    try {
      const patch: CloudDriveSettingsPatch = { ...draft }
      if (webdavPassword) patch.webdavPassword = webdavPassword
      const result = await clouddriveApi.patchSettings(patch)
      setSettings(result.settings)
      setWebdavPassword('')
      toast({ title: ct('clouddrive.settings.saved') })
    } catch (error) {
      toast({ title: ct('clouddrive.settings.save_failed'), description: error instanceof Error ? error.message : '', tone: 'danger' })
    } finally {
      setSaving(false)
    }
  }

  const emptyTrash = async () => {
    if (purging || !await confirm({ title: ct('clouddrive.settings.empty_trash'), tone: 'danger' })) return
    setPurging(true)
    try {
      const result = await clouddriveApi.purge({ all: true })
      toast({ title: ct('clouddrive.settings.empty_trash_done', { count: result.deleted }) })
      await load()
    } catch (error) {
      toast({ title: ct('clouddrive.settings.empty_trash_failed'), description: error instanceof Error ? error.message : '', tone: 'danger' })
    } finally {
      setPurging(false)
    }
  }

  if (status === 'loading') {
    return <div role="status" aria-live="polite" className="flex items-center justify-center gap-2 p-4 text-[var(--text-tertiary)]"><Spinner />{ct('clouddrive.loading')}</div>
  }
  if (status === 'error' || !settings) {
    return (
      <div role="alert" className="flex flex-col items-center justify-center gap-3 p-6 text-center">
        <p className="text-[length:var(--text-13)] text-[var(--text-secondary)]">{ct('clouddrive.settings.load_failed')}</p>
        <Button variant="secondary" onClick={() => void load()}>{ct('clouddrive.retry')}</Button>
      </div>
    )
  }
  const number = (value: unknown) => typeof value === 'number' ? value : 0
  // Every field below the title is a deployment policy: the server answers a member's PATCH with 403,
  // so the form shows the owner's values without pretending they can be edited here.
  const locked = !owner
  return (
    <div className="flex h-full min-h-0 flex-col gap-4 overflow-auto p-4">
      <h1 className="text-[length:var(--text-15)] font-semibold text-[var(--text-primary)]">{ct('clouddrive.settings.title')}</h1>
      {locked && (
        <p role="note" className="rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] px-3 py-2 text-[length:var(--text-11)] text-[var(--text-secondary)]">
          {ct('clouddrive.settings.policy_locked')}
        </p>
      )}
      <section className="rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-3">
        <h2 className="mb-2 text-[length:var(--text-13)] font-medium">{ct('clouddrive.settings.upload_section')}</h2>
        <div className="grid gap-2 sm:grid-cols-2">
          <Field label={ct('clouddrive.settings.max_file_size')}><Input type="number" readOnly={locked} value={number(draft.uploadMaxFileBytes)} onChange={(event) => setDraft({ ...draft, uploadMaxFileBytes: Number(event.target.value) })} /></Field>
          <Field label={ct('clouddrive.settings.part_size')}><Input type="number" readOnly={locked} value={number(draft.uploadPartSizeBytes)} onChange={(event) => setDraft({ ...draft, uploadPartSizeBytes: Number(event.target.value) })} /></Field>
          <Field label={ct('clouddrive.settings.concurrency')}><Input type="number" readOnly={locked} value={number(draft.uploadConcurrentParts)} onChange={(event) => setDraft({ ...draft, uploadConcurrentParts: Number(event.target.value) })} /></Field>
          <Field label={ct('clouddrive.settings.distributed_threshold')}><Input type="number" readOnly={locked} value={number(draft.uploadDistributedMinBytes)} onChange={(event) => setDraft({ ...draft, uploadDistributedMinBytes: Number(event.target.value) })} /></Field>
          <Field label={ct('clouddrive.settings.display_quota')} hint={ct('clouddrive.settings.display_quota_hint')}>
            <Input
              type="number"
              min={0}
              readOnly={locked}
              value={draft.storageDisplayQuotaBytes ?? ''}
              onChange={(event) => setDraft({
                ...draft,
                storageDisplayQuotaBytes: event.target.value === '' ? null : Number(event.target.value),
              })}
            />
          </Field>
        </div>
      </section>
      <section className="rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-3">
        <h2 className="mb-2 text-[length:var(--text-13)] font-medium">{ct('clouddrive.settings.share_section')}</h2>
        <div className="grid gap-2 sm:grid-cols-2">
          <Field label={ct('clouddrive.settings.default_expiry')}><Input type="number" readOnly={locked} value={number(draft.shareDefaultExpiryDays)} onChange={(event) => setDraft({ ...draft, shareDefaultExpiryDays: Number(event.target.value) })} /></Field>
          <Field label={ct('clouddrive.settings.max_expiry')}><Input type="number" readOnly={locked} value={number(draft.shareMaxExpiryDays)} onChange={(event) => setDraft({ ...draft, shareMaxExpiryDays: Number(event.target.value) })} /></Field>
          <label className="flex items-center gap-2 text-[length:var(--text-12)]"><Switch checked={draft.shareAllowMemberShares === true} disabled={locked} onChange={(value) => setDraft({ ...draft, shareAllowMemberShares: value })} label={ct('clouddrive.settings.member_shares')} />{ct('clouddrive.settings.member_shares')}</label>
        </div>
      </section>
      <section className="rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-3">
        <h2 className="mb-2 text-[length:var(--text-13)] font-medium">{ct('clouddrive.settings.trash_retention')}</h2>
        <Field label={ct('clouddrive.settings.trash_retention')}><Input type="number" readOnly={locked} value={number(draft.trashRetentionDays)} onChange={(event) => setDraft({ ...draft, trashRetentionDays: Number(event.target.value) })} /></Field>
      </section>
      {owner && (
        <section className="rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-3">
          <h2 className="mb-2 text-[length:var(--text-13)] font-medium">{ct('clouddrive.settings.webdav')}</h2>
          <label className="mb-2 flex items-center gap-2 text-[length:var(--text-12)]"><Switch checked={draft.webdavEnabled === true} onChange={(value) => setDraft({ ...draft, webdavEnabled: value })} label={ct('clouddrive.settings.webdav_enable')} />{ct('clouddrive.settings.webdav_enable')}</label>
          <div className="grid gap-2 sm:grid-cols-2">
            <Field label={ct('clouddrive.settings.webdav_username')}><Input value={draft.webdavUsername ?? ''} onChange={(event) => setDraft({ ...draft, webdavUsername: event.target.value })} /></Field>
            <Field label={ct('clouddrive.settings.webdav_password')}><Input type="password" value={webdavPassword} placeholder={settings.webdavHasPassword ? ct('clouddrive.settings.webdav_password_set') : ''} onChange={(event) => setWebdavPassword(event.target.value)} /></Field>
          </div>
        </section>
      )}
      <section className="rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-3">
        <h2 className="mb-2 text-[length:var(--text-13)] font-medium">{ct('clouddrive.settings.config_backup')}</h2>
        <p className="mb-3 text-[length:var(--text-11)] text-[var(--text-tertiary)]">{ct('clouddrive.settings.config_backup_hint')}</p>
        <ConfigBackupButton
          label={ct('clouddrive.settings.config_backup')}
          busyLabel={ct('clouddrive.settings.config_backup_busy')}
          successLabel={ct('clouddrive.settings.config_backup_done')}
          errorLabel={ct('clouddrive.settings.config_backup_failed')}
        />
      </section>
      <div className="flex flex-wrap items-center gap-2">
        {owner && <Button variant="primary" loading={saving} onClick={() => void save()}><Save size={13} /> {ct('clouddrive.dialog.save')}</Button>}
        {owner && <Button variant="danger" loading={purging} onClick={() => void emptyTrash()}><Trash2 size={13} /> {ct('clouddrive.settings.empty_trash')}</Button>}
      </div>
    </div>
  )
}
