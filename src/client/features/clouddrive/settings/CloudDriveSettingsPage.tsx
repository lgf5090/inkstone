import { useEffect, useState } from 'react'
import { Save, Trash2 } from 'lucide-react'
import type { CloudDrivePublicSettings, CloudDriveSettingsPatch } from '@shared/clouddrive/settings'
import { Button } from '../../../components/primitives'
import { Field, Input, Switch } from '../../../components/form'
import { confirm } from '../../../components/overlay'
import { useUi } from '../../../store/ui'
import { clouddriveApi } from '../api'
import { ct } from '../media-i18n'

export function CloudDriveSettingsPage({ owner }: { owner: boolean }) {
  const toast = useUi((state) => state.toast)
  const [settings, setSettings] = useState<CloudDrivePublicSettings | null>(null)
  const [saving, setSaving] = useState(false)
  const [webdavPassword, setWebdavPassword] = useState('')
  const [draft, setDraft] = useState<CloudDriveSettingsPatch>({})

  const load = async () => {
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
        webdavEnabled: result.settings.webdavEnabled,
        webdavUsername: result.settings.webdavUsername,
        adminOwnerCanViewMemberFiles: result.settings.adminOwnerCanViewMemberFiles,
      })
    } catch (error) {
      toast({ title: ct('clouddrive.settings.load_failed'), description: error instanceof Error ? error.message : '', tone: 'danger' })
    }
  }
  useEffect(() => { void load() }, [])

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

  if (!settings) return <div className="p-4 text-[var(--text-tertiary)]">{ct('clouddrive.loading')}</div>
  const number = (value: unknown) => typeof value === 'number' ? value : 0
  return (
    <div className="flex h-full min-h-0 flex-col gap-4 overflow-auto p-4">
      <h1 className="text-[length:var(--text-15)] font-semibold text-[var(--text-primary)]">{ct('clouddrive.settings.title')}</h1>
      <section className="rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-3">
        <h2 className="mb-2 text-[length:var(--text-13)] font-medium">{ct('clouddrive.settings.upload_section')}</h2>
        <div className="grid gap-2 sm:grid-cols-2">
          <Field label={ct('clouddrive.settings.max_file_size')}><Input type="number" value={number(draft.uploadMaxFileBytes)} onChange={(event) => setDraft({ ...draft, uploadMaxFileBytes: Number(event.target.value) })} /></Field>
          <Field label={ct('clouddrive.settings.part_size')}><Input type="number" value={number(draft.uploadPartSizeBytes)} onChange={(event) => setDraft({ ...draft, uploadPartSizeBytes: Number(event.target.value) })} /></Field>
          <Field label={ct('clouddrive.settings.concurrency')}><Input type="number" value={number(draft.uploadConcurrentParts)} onChange={(event) => setDraft({ ...draft, uploadConcurrentParts: Number(event.target.value) })} /></Field>
          <Field label={ct('clouddrive.settings.distributed_threshold')}><Input type="number" value={number(draft.uploadDistributedMinBytes)} onChange={(event) => setDraft({ ...draft, uploadDistributedMinBytes: Number(event.target.value) })} /></Field>
        </div>
      </section>
      <section className="rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-3">
        <h2 className="mb-2 text-[length:var(--text-13)] font-medium">{ct('clouddrive.settings.share_section')}</h2>
        <div className="grid gap-2 sm:grid-cols-2">
          <Field label={ct('clouddrive.settings.default_expiry')}><Input type="number" value={number(draft.shareDefaultExpiryDays)} onChange={(event) => setDraft({ ...draft, shareDefaultExpiryDays: Number(event.target.value) })} /></Field>
          <Field label={ct('clouddrive.settings.max_expiry')}><Input type="number" value={number(draft.shareMaxExpiryDays)} onChange={(event) => setDraft({ ...draft, shareMaxExpiryDays: Number(event.target.value) })} /></Field>
          <label className="flex items-center gap-2 text-[length:var(--text-12)]"><Switch checked={draft.shareAllowMemberShares === true} onChange={(value) => setDraft({ ...draft, shareAllowMemberShares: value })} label={ct('clouddrive.settings.member_shares')} />{ct('clouddrive.settings.member_shares')}</label>
        </div>
      </section>
      <section className="rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-3">
        <h2 className="mb-2 text-[length:var(--text-13)] font-medium">{ct('clouddrive.settings.trash_retention')}</h2>
        <Field label={ct('clouddrive.settings.trash_retention')}><Input type="number" value={number(draft.trashRetentionDays)} onChange={(event) => setDraft({ ...draft, trashRetentionDays: Number(event.target.value) })} /></Field>
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
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary" loading={saving} onClick={() => void save()}><Save size={13} /> {ct('clouddrive.dialog.save')}</Button>
        {owner && <Button variant="danger" onClick={async () => { if (await confirm({ title: ct('clouddrive.settings.empty_trash'), tone: 'danger' })) { await clouddriveApi.purge({ all: true }); toast({ title: ct('clouddrive.settings.empty_trash_done') }); await load() } }}><Trash2 size={13} /> {ct('clouddrive.settings.empty_trash')}</Button>}
      </div>
    </div>
  )
}
